import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import request from "supertest";
import type { Express } from "express";
import { createDbHandle, createNodeStore, settings, type DbHandle } from "@irori/db";
import { usageRequestSchema, type UsageRequest } from "@irori/core";
import { createUsageRollupEngine, USAGE_ROLLUP_WATERMARK_KEY } from "../src/usage-rollups.js";
import { createUsageStore } from "../src/usage-store.js";
import { runUsageRetention } from "../src/retention.js";
import { createApp } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";

/**
 * Requires a REAL Postgres (ADR-0002) — same contract as rollups.test.ts:
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
 *   IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres pnpm --filter @irori/server test
 *
 * Covers the ADR-0008 exactly-once path: dedup by UUID across redelivery,
 * watermark-guarded rollups (ingest-time keyed), the four usage endpoints
 * against real buckets, and the 90 d / 1 y retention pass.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

let handle: DbHandle | null = null;
let store: ReturnType<typeof createNodeStore> | null = null;
let nodeId = "";

function usageRequest(overrides: Partial<UsageRequest> = {}): UsageRequest {
  return usageRequestSchema.parse({
    id: randomUUID(),
    ts: Date.now() - 60_000,
    setupId: null,
    port: 8081,
    model: "GLM-5.3-Flash-EXL3",
    endpoint: "/v1/chat/completions",
    stream: true,
    status: 200,
    finishReason: "stop",
    error: null,
    errorSig: null,
    durationMs: 1000,
    ttftMs: 120,
    decodeTps: 40,
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 10,
    reasoningTokens: 5,
    totalTokens: 150,
    engineMeta: null,
    reqBytes: 1000,
    resBytes: 2000,
    sourceAddr: "127.0.0.1",
    ...overrides,
  });
}

beforeAll(async () => {
  if (url === undefined) return;
  handle = createDbHandle(url);
  await handle.migrate();
  store = createNodeStore(handle.db, "a".repeat(64));
  const { id } = await store.create({ name: `usage-${randomUUID().slice(0, 8)}`, kind: "spark", role: "head", host: "usage-test.local" });
  nodeId = id;
});

afterAll(async () => {
  if (handle === null || nodeId === "") return;
  await store!.remove(nodeId);
  await handle.close();
});

function makeApp(): Express {
  const store = createUsageStore(handle!.db);
  return createApp({
    getStore: () => null,
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    getJobs: () => null,
    getSetups: () => null,
    getBench: () => null,
    getAnalytics: () => null,
    getCleanup: () => null,
    getUsage: () => store,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => null,
    version: "test",
    tag: null,
    staticDir: null,
  });
}

d("usage store (postgres)", () => {
  it("deduplicates redelivered batches by UUID (exactly-once)", async () => {
    const store = createUsageStore(handle!.db);
    const batch = [usageRequest(), usageRequest({ model: null })];
    const first = await store.insertBatch(nodeId, batch);
    const second = await store.insertBatch(nodeId, batch); // replay — no-op
    expect(first).toBe(2);
    expect(second).toBe(0);
    const page = await store.requests({ range: "24h", page: 1, limit: 100 });
    expect(page.rows.filter((r) => batch.some((b) => b.id === r.id))).toHaveLength(2);
  });

  it("rolls up hourly/daily buckets on ingest time and advances the watermark", async () => {
    const store = createUsageStore(handle!.db);
    const events = [usageRequest(), usageRequest({ error: "boom", errorSig: "boom", status: 500 })];
    await store.insertBatch(nodeId, events);

    // The engine computes only COMPLETE buckets — move these rows into a
    // past hour so the run below deterministically covers them. Absolute
    // UTC instant (session TZ must not shift it).
    const pastHour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 2 * 3_600_000);
    await handle!.db.execute(sql`update llm_requests set received_at = ${pastHour.toISOString()}::timestamptz where node_id = ${nodeId}`);

    const engine = createUsageRollupEngine(handle!.db);
    // Watermark tests must not see a watermark left by an earlier run
    // (shared disposable DB) — same contract as rollups.test.ts.
    await handle!.db.execute(sql`delete from settings where key = ${USAGE_ROLLUP_WATERMARK_KEY}`);
    await engine.runOnce();

    const overview = await store.overview({ range: "24h", nodeId });
    const mine = overview.tokenMix.find((m) => m.model === "GLM-5.3-Flash-EXL3");
    expect(mine).toBeDefined();
    expect(mine!.requests).toBeGreaterThanOrEqual(2);
    expect(mine!.errors).toBeGreaterThanOrEqual(1);
    expect(mine!.totalTokens).toBeGreaterThanOrEqual(300); // 150 per event

    const wm = await handle!.db.select().from(settings).where(sql`${settings.key} = ${USAGE_ROLLUP_WATERMARK_KEY}`);
    expect(wm).toHaveLength(1);
    void store;
  });

  it("serves the four endpoints from real buckets", async () => {
    const app = makeApp();
    const base = `/api/v1/usage`;
    const overview = await request(app).get(`${base}/overview?range=24h&nodeId=${nodeId}`);
    expect(overview.status).toBe(200);
    expect(overview.body.granularity).toBe("hour");
    expect(overview.body.kpis.requests).toBeGreaterThanOrEqual(2);

    const requests = await request(app).get(`${base}/requests?range=24h&nodeId=${nodeId}&limit=10`);
    expect(requests.status).toBe(200);
    expect(requests.body.total).toBeGreaterThanOrEqual(2);
    const row = requests.body.rows[0];
    expect(row.nodeId).toBe(nodeId);
    expect(typeof row.receivedAtMs).toBe("number");

    const detail = await request(app).get(`${base}/requests/${row.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(row.id);

    const errors = await request(app).get(`${base}/errors?range=24h&nodeId=${nodeId}`);
    expect(errors.status).toBe(200);
    expect(errors.body.groups.some((g: { sig: string }) => g.sig === "boom")).toBe(true);

    const models = await request(app).get(`${base}/models?range=24h&nodeId=${nodeId}`);
    expect(models.status).toBe(200);
    expect(models.body.models.length).toBeGreaterThan(0);
  });

  it("prunes raw rows and buckets (90 d / 1 y)", async () => {
    const store = createUsageStore(handle!.db);
    await store.insertBatch(nodeId, [usageRequest()]);
    const result = await runUsageRetention(store, 90, 365);
    expect(result.raw).toBe(0); // nothing older than 90 d yet
    expect(result.hour).toBe(0);
  });
});
