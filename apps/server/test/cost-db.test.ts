import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDbHandle, llmRequests, nodes, usageBuckets, type Db, type DbHandle } from "@irori/db";
import { tokenCostMinor, usageCostGroupBySchema } from "@irori/core";
import { createCostService } from "../src/cost.js";
import { backfillUsageCost, createUsageRollupEngine } from "../src/usage-rollups.js";
import { createUsageStore } from "../src/usage-store.js";

/**
 * IRI-072 (epic IR-157 WS4): the cost engine against a REAL Postgres —
 * bucket stamping at rollup time, per-model override precedence
 * (exact > longest prefix > default), the chunked/resumable backfill, and
 * read consistency (overview cost == cost() rows == underlying buckets).
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("cost engine (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let nodeId: string;

  const price = async () => ({
    currency: "EUR" as const,
    resolve: (model: string) => (model.startsWith("priced") ? { input: 1, cached: 0.1, output: 2, currency: "EUR" as const } : null),
  });

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.insert(nodes).values({
      id: nodeId,
      name: `cost-test-${nodeId.slice(0, 8)}`,
      kind: "spark",
      role: "standalone",
      host: "localhost",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
    await db.delete(usageBuckets);
    await db.delete(llmRequests);
  });

  afterAll(async () => {
    await db.delete(nodes).where(eq(nodes.id, nodeId));
    await handle.close();
  });

  let seq = 0;
  const event = (model: string, prompt: number, cached: number, completion: number) => ({
    id: randomUUID(),
    ts: Date.now(),
    setupId: null,
    port: 8081,
    model,
    endpoint: "/v1/chat/completions",
    stream: false,
    status: 200,
    finishReason: "stop",
    error: null,
    errorSig: null,
    durationMs: 100,
    ttftMs: 10,
    decodeTps: null,
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
    reasoningTokens: 0,
    totalTokens: prompt + completion,
    engineMeta: null,
    reqBytes: 1,
    resBytes: 1,
    sourceAddr: "127.0.0.1",
    parts: [],
    respTools: [],
    toolResults: [],
    retryAttempt: null,
    retryKind: null,
    retryStatus: null,
    retrySupersededBy: null,
    receivedAtMs: Date.now(),
    seq: (seq += 1),
  });

  it("stamps bucket cost at rollup time and prices per model", async () => {
    const store = createUsageStore(db, { pricing: price });
    await store.insertBatch(nodeId, [event("priced-model", 1_000_000, 200_000, 100_000), event("unpriced-model", 500_000, 0, 0)]);
    // Other suites write the rollup watermark (shared settings table) — reset
    // it so this engine pass covers the fresh rows from the earliest time.
    await db.execute(sql`delete from settings where key = 'usage_rollup_watermark'`);
    const engine = createUsageRollupEngine(db, price);
    await engine.runOnce(new Date(Date.now() + 3_600_000));

    const buckets = await db.select().from(usageBuckets);
    const priced = buckets.find((b) => b.model === "priced-model");
    // (1M−200k)×1 + 200k×0.1 + 100k×2 = 0.8 + 0.02 + 0.2 EUR = 1.02 → 102 minor.
    expect(priced?.costMinor).toBe(102);
    expect(priced?.costCurrency).toBe("EUR");
    // No price resolved → null (never a fake zero).
    const unpriced = buckets.find((b) => b.model === "unpriced-model");
    expect(unpriced?.costMinor).toBeNull();
  });

  it("answers overview/models/cost consistently with the buckets", async () => {
    const store = createUsageStore(db, { pricing: price });
    await db.delete(llmRequests); // self-contained inputs (prior tests' rows pollute the open fold)
    await db.execute(sql`delete from settings where key = 'usage_rollup_watermark'`);
    await db.delete(usageBuckets);
    await store.insertBatch(nodeId, [event("priced-model", 1_000_000, 200_000, 100_000), event("unpriced-model", 500_000, 0, 0)]);
    // Backdate BEFORE rolling so the buckets land in complete hours — the
    // overview's open-bucket fold double-counts rows the engine already
    // covered (its contract assumes the watermark trails the open hour).
    await db.execute(sql`update llm_requests set received_at = received_at - interval '3 hours' where node_id = ${nodeId}`);
    const engine = createUsageRollupEngine(db, price);
    await engine.runOnce(new Date(Date.now() + 3_600_000 * 3));
    const overview = await store.overview({ range: "24h" });
    expect(overview.costCurrency).toBe("EUR");
    // Like-for-like: the overview reads HOUR buckets for a 24h range (the
    // engine also writes day buckets — excluded here and in every read).
    const bucketSum = (
      await db.select({ m: sql<number>`sum(cost_minor)::int` }).from(usageBuckets).where(eq(usageBuckets.granularity, "hour"))
    )[0]!.m;
    expect(overview.costMinor).toBe(bucketSum);

    const cost = await store.cost({ range: "24h", groupBy: usageCostGroupBySchema.parse("model") });
    expect(cost.totalMinor).toBe(bucketSum);
    const pricedRow = cost.rows.find((r) => r.key === "priced-model");
    expect(pricedRow?.costMinor).toBe(102);

    const models = await store.models({ range: "24h" });
    expect(models.models.find((m) => m.model === "priced-model")?.costMinor).toBe(102);
  });

  it("backfills null-cost buckets idempotently (count reported)", async () => {
    // Fresh buckets for THIS test (insert + rollup), then strip their cost.
    await db.delete(llmRequests);
    await db.execute(sql`delete from settings where key = 'usage_rollup_watermark'`);
    await db.delete(usageBuckets);
    const store = createUsageStore(db, { pricing: price });
    await store.insertBatch(nodeId, [event("priced-model", 1_000_000, 200_000, 100_000), event("unpriced-model", 500_000, 0, 0)]);
    const engine = createUsageRollupEngine(db, price);
    // Rollup windows bucket on received_at — backdate the rows 3 h so the
    // stamped buckets fall before the backfill's `current hour` cutoff.
    await engine.runOnce(new Date(Date.now() + 3_600_000));
    await db.execute(sql`update llm_requests set received_at = received_at - interval '3 hours' where node_id = ${nodeId}`);
    await db.execute(sql`delete from settings where key = 'usage_rollup_watermark'`);
    await db.delete(usageBuckets); // drop buckets keyed on the pre-backdate windows
    await engine.runOnce(new Date(Date.now() + 3_600_000 * 3));
    await db.execute(sql`update usage_buckets set cost_minor = null, cost_currency = null`);
    const first = await backfillUsageCost(db, (model) => (model.startsWith("priced") ? { input: 1, cached: 0.1, output: 2, currency: "EUR" } : null), 500);
    expect(first.stamped).toBe(1); // exactly one priced bucket (both events share the hour)
    // Unpriced models resolve null → their buckets stay NULL (never fake
    // zero), so `remaining` counts only buckets that can still be priced.
    expect(first.remaining).toBe(0);
    const priced = await db.select().from(usageBuckets).where(eq(usageBuckets.model, "priced-model"));
    expect(priced[0]!.costMinor).toBe(102);
    // Second pass: nothing left to stamp (idempotent).
    const second = await backfillUsageCost(db, (model) => (model.startsWith("priced") ? { input: 1, cached: 0.1, output: 2, currency: "EUR" } : null), 500);
    expect(second.stamped).toBe(0);
  });

  it("override precedence: exact > longest prefix > default (cost service)", async () => {
    const service = createCostService(db);
    await service.setToken({ input: 9, cached: 9, output: 9, currency: "USD" });
    await service.setModelPrice({ pattern: "glm", input: 1, cached: 0.1, output: 2, currency: "EUR" });
    await service.setModelPrice({ pattern: "glm-5.3", input: 3, cached: 0.3, output: 4, currency: "EUR" });
    await service.setModelPrice({ pattern: "glm-5.3-flash-exl3", input: 5, cached: 0.5, output: 6, currency: "EUR" });
    const snap = await service.snapshot();
    expect(snap.resolve("glm-5.3-flash-exl3")?.input).toBe(5); // exact
    expect(snap.resolve("glm-5.3-flash")?.input).toBe(3); // longest prefix
    expect(snap.resolve("glm-x")?.input).toBe(1); // short prefix
    expect(snap.resolve("other-model")?.input).toBe(9); // default
    expect(snap.currency).toBe("USD");
    await service.deleteModelPrice("glm");
    await service.deleteModelPrice("glm-5.3");
    await service.deleteModelPrice("glm-5.3-flash-exl3");
  });

  it("tokenCostMinor never fakes zero: null price → null, zero price → 0", () => {
    expect(tokenCostMinor({ promptTokens: 1000, cachedTokens: 0, completionTokens: 0 }, null)).toBeNull();
    expect(tokenCostMinor({ promptTokens: 1000, cachedTokens: 0, completionTokens: 0 }, { input: 0, cached: 0, output: 0, currency: "EUR" })).toBe(0);
    // Failed requests keep their prompt tokens in cost (no exclusion path).
    expect(tokenCostMinor({ promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 }, { input: 1, cached: 0, output: 0, currency: "EUR" })).toBe(100);
  });
});
