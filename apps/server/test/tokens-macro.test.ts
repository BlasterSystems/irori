import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createDbHandle, nodes, setups, tokenLedger, type DbHandle } from "@irori/db";
import { createTokenMacroService, type TokenMacroService } from "../src/tokens-macro.js";
import { createApp } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";

/**
 * Token macro views (IRI-040/IR-118) — db-gated like the other Postgres
 * suites: IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres
 * Cleanup is scoped to this suite's tables (shared test DB — never drop-all).
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

let handle: DbHandle | null = null;
let macro: TokenMacroService;
let app: Express;
const nodeIds = { dgx1: randomUUID(), dgx2: randomUUID(), dgx3: randomUUID() };
let setupId = "";

beforeAll(async () => {
  handle = createDbHandle(url!);
  await handle.migrate();
  macro = createTokenMacroService(handle.db);

  await handle.db.insert(nodes).values([
    { id: nodeIds.dgx1, name: "DGX-1", kind: "spark", role: "head", host: "dgx1", agentTokenHash: "a".repeat(64), agentTokenEnc: "e1" },
    { id: nodeIds.dgx2, name: "DGX-2", kind: "spark", role: "worker", host: "dgx2", agentTokenHash: "b".repeat(64), agentTokenEnc: "e2" },
    { id: nodeIds.dgx3, name: "DGX-3", kind: "spark", role: "standalone", host: "dgx3", agentTokenHash: "c".repeat(64), agentTokenEnc: "e3" },
  ]);
  setupId = randomUUID();
  await handle.db.insert(setups).values({
    id: setupId,
    name: "GLM TP-3",
    kind: "cluster",
    model: "GLM-5.3-Flash-EXL3",
    port: 8081,
    headNodeId: nodeIds.dgx1,
    nodes: [{ nodeId: nodeIds.dgx2, role: "worker" }],
    scriptStart: "/bin/true",
    scriptStop: "/bin/true",
  });

  const hourStart = (msAgo: number): Date => new Date(Math.floor((Date.now() - msAgo) / 3_600_000) * 3_600_000);
  const ledgerRow = (nodeId: string, model: string, gen: number, prompt: number, cached: number) => ({
    nodeId,
    port: 8081,
    model,
    granularity: "hour" as const,
    bucketStart: hourStart(3_600_000),
    samples: 1,
    generatedTokens: gen,
    promptTokens: prompt,
    cachedTokens: cached,
    generatedSeen: gen > 0,
    promptSeen: prompt > 0,
    cachedSeen: cached > 0,
  });
  await handle.db.insert(tokenLedger).values([
    ledgerRow(nodeIds.dgx1, "GLM-5.3-Flash-EXL3", 100, 200, 50),
    ledgerRow(nodeIds.dgx1, "q27", 10, 0, 0),
    ledgerRow(nodeIds.dgx2, "GLM-5.3-Flash-EXL3", 30, 90, 90),
    ledgerRow(nodeIds.dgx3, "ds4", 5, 10, 2),
  ]);

  app = createApp({
    getStore: () => null,
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    getJobs: () => null,
    getSetups: () => null,
    getBench: () => null,
    getAnalytics: () => null,
    getTokenMacro: () => macro,
    getCleanup: () => null,
    getUsage: () => null,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => null,
    version: "test",
    tag: null,
    staticDir: null,
  });
});

afterAll(async () => {
  if (handle === null) return;
  await handle.db.delete(tokenLedger);
  await handle.db.delete(setups);
  await handle.db.delete(nodes);
  await handle.close();
});

d("token macro service (postgres)", () => {
  it("aggregates fleet / clusters / nodes / models with derived metrics", async () => {
    const res = await macro.build({ range: "24h" });
    // fleet: gen 100+10+30+5=145, input 200+0+90+10=300, cached 50+0+90+2=142
    expect(res.fleet).toEqual({ total: 445, generated: 145, input: 300, cached: 142, cacheHitPct: 47.3 });

    // clusters: the setup folds head+worker; standalone nodes get their own row
    expect(res.clusters).toHaveLength(2);
    const tp3 = res.clusters.find((c) => c.name === "GLM TP-3")!;
    expect(tp3).toEqual({ id: setupId, name: "GLM TP-3", total: 430, generated: 140, input: 290, cached: 140, cacheHitPct: 48.3 });
    const standalone = res.clusters.find((c) => c.id === "standalone")!;
    expect(standalone).toEqual({ id: "standalone", name: "standalone", total: 15, generated: 5, input: 10, cached: 2, cacheHitPct: 20 });

    // nodes: sorted by total desc, cluster name attached, null when standalone
    expect(res.nodes.map((n) => [n.name, n.total, n.cacheHitPct, n.cluster])).toEqual([
      ["DGX-1", 310, 25, "GLM TP-3"],
      ["DGX-2", 120, 100, "GLM TP-3"],
      ["DGX-3", 15, 20, null],
    ]);

    // models: whole-ledger sums (not top-20-capped), zero input → 0% hit
    expect(res.models.map((m) => [m.model, m.total, m.generated, m.input, m.cached, m.cacheHitPct])).toEqual([
      ["GLM-5.3-Flash-EXL3", 420, 130, 290, 140, 48.3],
      ["ds4", 15, 5, 10, 2, 20],
      ["q27", 10, 10, 0, 0, 0],
    ]);
  });

  it("serves the route: 200 with shape, 400 on bad range, 503 when degraded", async () => {
    const res = await request(app).get("/api/v1/analytics/tokens-macro?range=24h");
    expect(res.status).toBe(200);
    expect(res.body.fleet.total).toBe(445);
    expect(res.body.nodes).toHaveLength(3);
    expect(res.body.models[0].model).toBe("GLM-5.3-Flash-EXL3");

    expect((await request(app).get("/api/v1/analytics/tokens-macro?range=fortnight")).status).toBe(400);

    const degraded = createApp({
      getStore: () => null,
      getLlmStore: () => null,
      getHistory: () => null,
      getLlmHistory: () => null,
      getJobs: () => null,
      getSetups: () => null,
      getBench: () => null,
      getAnalytics: () => null,
      getTokenMacro: () => null,
      getCleanup: () => null,
      getUsage: () => null,
      dbHealthy: async () => false,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      version: "test",
      tag: null,
      staticDir: null,
    });
    expect((await request(degraded).get("/api/v1/analytics/tokens-macro?range=24h")).status).toBe(503);
  });

  it("answers zeros on an empty ledger (runs last — clears the fixtures)", async () => {
    await handle!.db.delete(tokenLedger);
    const res = await macro.build({ range: "24h" });
    expect(res.fleet).toEqual({ total: 0, generated: 0, input: 0, cached: 0, cacheHitPct: 0 });
    expect(res.clusters).toEqual([]);
    expect(res.nodes).toEqual([]);
    expect(res.models).toEqual([]);
  });
});
