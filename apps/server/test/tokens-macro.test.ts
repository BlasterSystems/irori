import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { createDbHandle, nodes, setups, tokenLedger, type DbHandle } from "@irori/db";
import { createAnalyticsService, type AnalyticsService } from "../src/analytics.js";

/**
 * Tokens lens macro fields (IRI-040/IR-118) — db-gated like the other
 * Postgres suites:
 *   IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres pnpm --filter @irori/server test
 *
 * The suite is HERMETIC against the shared test DB: fixtures use unique
 * model names (`iri040-*`) and unique node ids; every query scopes via the
 * lens' own setupId/nodeId filters (which scope `series` AND `fleet`);
 * cleanup deletes only this suite's rows. Parallel vitest files share the
 * one database — never delete-all.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const SETUP_ID = randomUUID();
const NODES = { dgx1: randomUUID(), dgx2: randomUUID(), dgx3: randomUUID() };
const MODELS = { a: "iri040-a", b: "iri040-b", c: "iri040-c" };

let handle: DbHandle | null = null;
let analytics: AnalyticsService;

beforeAll(async () => {
  handle = createDbHandle(url!);
  await handle.migrate();
  analytics = createAnalyticsService(handle.db);

  await handle.db.insert(nodes).values([
    { id: NODES.dgx1, name: "iri040 DGX-1", kind: "spark", role: "head", host: "iri040-dgx1", agentTokenHash: "a".repeat(64), agentTokenEnc: "e1" },
    { id: NODES.dgx2, name: "iri040 DGX-2", kind: "spark", role: "worker", host: "iri040-dgx2", agentTokenHash: "b".repeat(64), agentTokenEnc: "e2" },
    { id: NODES.dgx3, name: "iri040 DGX-3", kind: "spark", role: "standalone", host: "iri040-dgx3", agentTokenHash: "c".repeat(64), agentTokenEnc: "e3" },
  ]);
  await handle.db.insert(setups).values({
    id: SETUP_ID,
    name: "iri040 cluster",
    kind: "cluster",
    model: MODELS.a,
    port: 8081,
    headNodeId: NODES.dgx1,
    nodes: [{ nodeId: NODES.dgx2, role: "worker" }],
    scriptStart: "/bin/true",
    scriptStop: "/bin/true",
  });

  const hourStart = new Date(Math.floor((Date.now() - 3_600_000) / 3_600_000) * 3_600_000);
  const ledgerRow = (nodeId: string, model: string, gen: number, prompt: number, cached: number) => ({
    nodeId,
    port: 8081,
    model,
    granularity: "hour" as const,
    bucketStart: hourStart,
    samples: 1,
    generatedTokens: gen,
    promptTokens: prompt,
    cachedTokens: cached,
    generatedSeen: gen > 0,
    promptSeen: prompt > 0,
    cachedSeen: cached > 0,
  });
  await handle.db.insert(tokenLedger).values([
    ledgerRow(NODES.dgx1, MODELS.a, 100, 200, 50),
    ledgerRow(NODES.dgx1, MODELS.b, 10, 0, 0),
    ledgerRow(NODES.dgx2, MODELS.a, 30, 90, 90),
    ledgerRow(NODES.dgx3, MODELS.c, 5, 10, 2),
  ]);
});

afterAll(async () => {
  if (handle === null) return;
  // Scoped cleanup only — parallel suites share this database.
  await handle.db.delete(tokenLedger).where(inArray(tokenLedger.nodeId, [NODES.dgx1, NODES.dgx2, NODES.dgx3]));
  await handle.db.delete(setups).where(eq(setups.id, SETUP_ID));
  await handle.db.delete(nodes).where(inArray(nodes.id, [NODES.dgx1, NODES.dgx2, NODES.dgx3]));
  await handle.close();
});

d("tokens lens macro fields (postgres)", () => {
  it("returns filtered fleet totals, macro models, and the folded cluster series", async () => {
    const res = await analytics.build({ lens: "tokens", range: "24h", groupBy: "cluster", setupId: SETUP_ID });
    // fleet follows the setupId filter: the cluster's head+worker tokens only.
    expect(res.fleet).toEqual({ total: 430, generated: 140, prompt: 290, cached: 140, cacheHitPct: 48.3 });
    // series: exactly the filtered setup, head+worker folded in.
    expect(res.series).toHaveLength(1);
    const sum = res.series[0]!.points.reduce((acc, p) => acc + (p.generated ?? 0) + (p.prompt ?? 0), 0);
    expect(sum).toBe(430);

    // models are fleet-wide by design; filter to this suite's unique models.
    const mine = res.models.filter((m) => m.model.startsWith("iri040-"));
    expect(mine.map((m) => [m.model, m.total, m.generated, m.prompt, m.cached, m.cacheHitPct])).toEqual([
      [MODELS.a, 420, 130, 290, 140, 48.3],
      [MODELS.c, 15, 5, 10, 2, 20],
      [MODELS.b, 10, 10, 0, 0, 0],
    ]);
  });

  it("scopes fleet to a node filter (cluster member and standalone node)", async () => {
    const head = await analytics.build({ lens: "tokens", range: "24h", groupBy: "node", nodeId: NODES.dgx1 });
    expect(head.fleet).toEqual({ total: 310, generated: 110, prompt: 200, cached: 50, cacheHitPct: 25 });
    expect(head.series).toHaveLength(1);
    expect(head.series[0]!.label).toBe("iri040 DGX-1");

    // A node in no setup — the standalone path of the cluster folding.
    const standalone = await analytics.build({ lens: "tokens", range: "24h", groupBy: "node", nodeId: NODES.dgx3 });
    expect(standalone.fleet).toEqual({ total: 15, generated: 5, prompt: 10, cached: 2, cacheHitPct: 20 });
  });

  it("answers zero totals once this suite's rows are gone (runs last)", async () => {
    await handle!.db.delete(tokenLedger).where(inArray(tokenLedger.nodeId, [NODES.dgx1, NODES.dgx2, NODES.dgx3]));
    const res = await analytics.build({ lens: "tokens", range: "24h", groupBy: "cluster", setupId: SETUP_ID });
    expect(res.fleet).toEqual({ total: 0, generated: 0, prompt: 0, cached: 0, cacheHitPct: 0 });
    // Pre-existing lens behavior: the group shell survives with empty buckets.
    expect(res.series.map((s) => s.points.length)).toEqual([0]);
    expect(res.models.filter((m) => m.model.startsWith("iri040-"))).toEqual([]);
  });
});
