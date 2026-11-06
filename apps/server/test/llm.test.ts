import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { WebSocket } from "ws";
import { SCHEMA_VERSION, llmPortSnapshotSchema, type LlmPortSnapshot } from "@irori/core";
import {
  createDbHandle,
  createNodeStore,
  llmBuckets,
  llmSnapshots,
  nodes,
  settings,
  type DbHandle,
  type NodeStore,
} from "@irori/db";
import { computeLlmBuckets, createLlmRollupEngine, LLM_ROLLUP_WATERMARK_KEY } from "../src/llm-rollups.js";
import { buildLlmHistory, seriesFromBucketRows } from "../src/llm-history.js";
import { createLlmStore, type LlmStore } from "../src/llm-store.js";
import { runLlmRetention } from "../src/retention.js";
import { createApp } from "../src/app.js";
import { createAgentHub, type AgentHubDeps } from "../src/hub.js";
import { createSetupsService } from "../src/setups-service.js";
import { createRings, type Rings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import {
  listen,
  makeFakeStore,
  type FakeStores,
  makeLlmMsg,
  makeLlmPort,
  makeSseSpy,
  nextMessage,
  opened,
  sleep,
} from "./helpers.js";

const hello = (token: string, agentVersion = "0.1.0") =>
  JSON.stringify({ type: "hello", schemaVersion: SCHEMA_VERSION, agentVersion, token, hostname: "spark1" });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function handshake(url: string, token: string) {
  const ws = new WebSocket(url);
  await opened(ws);
  ws.send(hello(token));
  // Attach both listeners before awaiting: hello-ok and config-update are sent
  // back-to-back and can land in one TCP segment.
  const helloOk = nextMessage(ws);
  const config = nextMessage(ws);
  return { ws, helloOk: await helloOk, config: await config };
}

async function waitUntil(cond: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(10);
  }
  expect(await cond()).toBe(true);
}

describe("llm history series grouping (pure)", () => {
  it("groups bucket-start-ordered rows into contiguous per-port series", () => {
    const rows = [
      {
        port: 8000,
        bucketStart: new Date(1000),
        decodeTps: 40,
        prefillTps: null,
        queueRunning: null,
        queueWaiting: null,
        kvCachePct: null,
        ttftP95Ms: 200,
        samples: 2,
      },
      {
        port: 8000,
        bucketStart: new Date(2000),
        decodeTps: 60,
        prefillTps: null,
        queueRunning: 1,
        queueWaiting: null,
        kvCachePct: null,
        ttftP95Ms: 400,
        samples: 3,
      },
      {
        port: 9001,
        bucketStart: new Date(1000),
        decodeTps: null,
        prefillTps: 900,
        queueRunning: null,
        queueWaiting: 4,
        kvCachePct: 12.5,
        ttftP95Ms: null,
        samples: 1,
      },
    ];

    expect(seriesFromBucketRows(rows)).toEqual([
      {
        port: 8000,
        points: [
          { t: 1000, decodeTps: 40, prefillTps: null, queueRunning: null, queueWaiting: null, kvCachePct: null, ttftP95Ms: 200, samples: 2 },
          { t: 2000, decodeTps: 60, prefillTps: null, queueRunning: 1, queueWaiting: null, kvCachePct: null, ttftP95Ms: 400, samples: 3 },
        ],
      },
      {
        port: 9001,
        points: [
          { t: 1000, decodeTps: null, prefillTps: 900, queueRunning: null, queueWaiting: 4, kvCachePct: 12.5, ttftP95Ms: null, samples: 1 },
        ],
      },
    ]);
  });
});

describe("llm ingest + config-update (hub, fake store)", () => {
  async function setup(overrides: Partial<AgentHubDeps> = {}) {
    const fake = makeFakeStore();
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const rings = createRings();
    const { events, sse } = makeSseSpy();
    const hub = createAgentHub({
      store: fake.store,
      llmStore: fake.llmStore,
      rings,
      sse,
      getCadenceMs: () => 2000,
      serverVersion: "test-server",
      writeFlushMs: 30,
      ...overrides,
    });
    const server = createServer();
    hub.attach(server);
    const port = await listen(server);
    const url = `ws://127.0.0.1:${port}/agent-ws`;
    cleanups.push(() => {
      hub.stop();
      server.close();
      server.closeAllConnections();
    });
    return { fake, created, rings, events, hub, url };
  }

  it("fans an llm frame into the ring, SSE, and the llm store", async () => {
    const { url, created, rings, events, fake } = await setup();
    const { ws } = await handshake(url, created.token);
    const port = makeLlmPort();
    ws.send(makeLlmMsg([port]));
    await sleep(30);
    expect(rings.latestLlm(created.id)).toEqual({ serverTimeMs: expect.any(Number), ports: [port] });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "llm", nodeId: created.id, ports: [port] }),
    );
    expect(fake.llmSnapshots).toEqual([
      { nodeId: created.id, payload: { schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", ports: [port] } },
    ]);
    ws.close();
  });

  it("buffers llm passes while the DB is down and flushes on recovery", async () => {
    const { url, created, fake } = await setup();
    const { ws } = await handshake(url, created.token);
    fake.setFailLlmInserts(true);
    for (let i = 0; i < 3; i++) ws.send(makeLlmMsg());
    await sleep(80);
    expect(fake.llmSnapshots).toEqual([]);
    fake.setFailLlmInserts(false);
    await waitUntil(() => fake.llmSnapshots.length === 3);
    ws.close();
  });

  it("sends config-update with role-derived cadence and validated llmPorts", async () => {
    const { url, created, fake } = await setup();
    // Head (default): no ports, probe cadence, not detect-only.
    const head = await handshake(url, created.token);
    expect(head.config).toEqual({
      type: "config-update",
      cadenceMs: 2000,
      llmPorts: [],
      llmCadenceMs: 2000,
      llmDetectOnly: false,
      nasRoot: null,
      cacheUser: null,
    });

    // Worker with mixed junk in llmPorts: valid entries kept, garbage dropped.
    const worker = await fake.store.create({ name: "worker1", kind: "spark", role: "worker", host: "w.local" });
    fake.rows.get(worker.id)!.llmPorts = [{ port: 8000, host: "0.0.0.0" }, { garbage: true }, 42];
    const ws = await handshake(url, worker.token);
    expect(ws.config).toEqual({
      type: "config-update",
      cadenceMs: 2000,
      llmPorts: [{ port: 8000, host: "0.0.0.0" }],
      llmCadenceMs: 10_000,
      llmDetectOnly: true,
      nasRoot: null,
      cacheUser: null,
    });
    ws.ws.close();
    head.ws.close();
  });
});

describe("llm routes (fake store)", () => {
  function makeApi(overrides: { store?: null } = {}) {
    const fake = makeFakeStore();
    const rings = createRings();
    const app = createApp({
      getStore: () => (overrides.store === null ? null : fake.store),
      getLlmStore: () => (overrides.store === null ? null : fake.llmStore),
      getHistory: () => null,
      getLlmHistory: () => null,
      dbHealthy: async () => true,
      rings,
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      version: "test",
      staticDir: null,
    });
    return { fake, rings, app };
  }

  async function nodeId(fake: FakeStores): Promise<string> {
    const { id } = await fake.store.create({ name: `n-${randomUUID()}`, kind: "spark", role: "head", host: "x" });
    return id;
  }

  it("serves the ring, then the latest persisted pass, then 404", async () => {
    const { fake, rings, app } = makeApi();
    const id = await nodeId(fake);

    expect((await request(app).get(`/api/v1/nodes/${id}/llm`)).status).toBe(404);

    await fake.llmStore.insertLlmSnapshot(id, { schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", ports: [makeLlmPort()] });
    const fallback = await request(app).get(`/api/v1/nodes/${id}/llm`);
    expect(fallback.status).toBe(200);
    expect(fallback.body.ports).toHaveLength(1);
    expect(typeof fallback.body.updatedAt).toBe("string");

    // Ring wins over the stored row once the agent is connected.
    rings.pushLlm(id, { serverTimeMs: 1234, ports: [makeLlmPort()] });
    const ringed = await request(app).get(`/api/v1/nodes/${id}/llm`);
    expect(ringed.status).toBe(200);
    expect(ringed.body.updatedAt).toBe(new Date(1234).toISOString());

    expect((await request(app).get(`/api/v1/nodes/${randomUUID()}/llm`)).status).toBe(404);
    expect((await request(app).get("/api/v1/nodes/nope/llm")).status).toBe(400);
  });

  it("answers the empty set for a NAS — no LLM surface, not a transient 404 (IR-192)", async () => {
    const { app, fake } = makeApi();
    const { id } = await fake.store.create({ name: `nas-${randomUUID()}`, kind: "nas", role: "standalone", host: "nas" });
    const res = await request(app).get(`/api/v1/nodes/${id}/llm`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ports: [], updatedAt: null });
  });

  it("answers 503 while degraded", async () => {
    const { app } = makeApi({ store: null });
    const res = await request(app).get(`/api/v1/nodes/${randomUUID()}/llm`);
    expect(res.status).toBe(503);
  });

  it("persists, dedupes and sorts PUT /llm-ports assignments", async () => {
    const { fake, app } = makeApi();
    const id = await nodeId(fake);

    const res = await request(app).put(`/api/v1/nodes/${id}/llm-ports`).send({ ports: [9001, 8000, 9001] });
    expect(res.status).toBe(200);
    expect(res.body.llmPorts).toEqual([
      { port: 8000, host: "127.0.0.1" },
      { port: 9001, host: "127.0.0.1" },
    ]);
    const [row] = await Promise.resolve([fake.rows.get(id)!]);
    expect(row.llmPorts).toEqual(res.body.llmPorts);

    expect((await request(app).put(`/api/v1/nodes/${id}/llm-ports`).send({ ports: "x" })).status).toBe(400);
    expect((await request(app).put(`/api/v1/nodes/${id}/llm-ports`).send({ ports: [0] })).status).toBe(400);
    expect((await request(app).put(`/api/v1/nodes/${id}/llm-ports`).send({ ports: [-3] })).status).toBe(400);
    expect((await request(app).put(`/api/v1/nodes/${id}/llm-ports`).send({})).status).toBe(400);
    expect((await request(app).put(`/api/v1/nodes/${randomUUID()}/llm-ports`).send({ ports: [8000] })).status).toBe(404);
  });
});

/**
 * Requires a REAL Postgres (ADR-0002), like rollups.test.ts.
 * IRORI_TEST_DATABASE_URL must point at a DISPOSABLE database:
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
 *   IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres pnpm --filter @irori/server test
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("llm (db integration)", () => {
  let h: DbHandle;
  let store: NodeStore;
  let llmStore: LlmStore;
  let rings: Rings;
  const createdIds: string[] = [];

  beforeAll(async () => {
    h = createDbHandle(url!);
    await h.migrate();
    store = createNodeStore(h.db, "a".repeat(64));
    llmStore = createLlmStore(h.db);
    rings = createRings();
  });

  beforeEach(async () => {
    // Engine tests must not see a watermark left by an earlier test/run.
    await h.db.delete(settings).where(eq(settings.key, LLM_ROLLUP_WATERMARK_KEY));
  });

  afterAll(async () => {
    if (createdIds.length > 0) await h.db.delete(nodes).where(inArray(nodes.id, createdIds));
    await h.close();
  });

  async function makeNode(label: string, role: "head" | "worker" | "standalone" = "head") {
    const created = await store.create({
      name: `${label}-${randomUUID()}`,
      kind: "spark",
      role,
      host: `${label}.test`,
    });
    createdIds.push(created.id);
    return created;
  }

  function port(portNum: number, overrides: Partial<LlmPortSnapshot> = {}): LlmPortSnapshot {
    return llmPortSnapshotSchema.parse({
      port: portNum,
      backend: "exl3",
      detected: true,
      probedAtMs: 1_000_000 + portNum,
      ...overrides,
    });
  }

  async function seedLlm(nodeId: string, serverTime: Date, ports: LlmPortSnapshot[]) {
    await h.db
      .insert(llmSnapshots)
      .values({ nodeId, serverTime, payload: { schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", ports } });
  }

  function bucketsFor(nodeId: string) {
    return h.db.select().from(llmBuckets).where(eq(llmBuckets.nodeId, nodeId)).orderBy(llmBuckets.port, llmBuckets.bucketStart);
  }

  function makeApiApp(refreshed?: string[]) {
    return createApp({
      getStore: () => store,
      getLlmStore: () => llmStore,
      getHistory: () => null,
      getLlmHistory: () => (id, range) => buildLlmHistory(h.db, id, range),
      dbHealthy: async () => true,
      rings,
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () =>
        refreshed === undefined
          ? null
          : {
              online: () => new Set<string>(),
              sendToNode: () => true,
              refreshConfig: async (nodeId: string) => {
                refreshed.push(nodeId);
                return true;
              },
            },
      version: "test",
      staticDir: null,
    });
  }

  it("aggregates llm buckets per (node, port) on UTC minute boundaries, skipping nulls", async () => {
    const { id: nodeId } = await makeNode("llm-rollup");
    // 10:00 bucket, port 8000: two samples → decode 50, ttft 300.
    // port 8001: decode only in the second sample → 30; kv avg(10, 30) = 20.
    await seedLlm(nodeId, new Date("2026-01-15T10:00:10Z"), [
      port(8000, { decodeTps: 40, ttftP95Ms: 200 }),
      port(8001, { decodeTps: null, queueRunning: 2, kvCachePct: 10 }),
    ]);
    await seedLlm(nodeId, new Date("2026-01-15T10:00:50Z"), [
      port(8000, { decodeTps: 60, ttftP95Ms: 400 }),
      port(8001, { decodeTps: 30, queueRunning: null, kvCachePct: 30 }),
    ]);

    const written = await computeLlmBuckets(
      h.db,
      "minute",
      new Date("2026-01-15T09:59:00Z"),
      new Date("2026-01-15T10:03:00Z"),
    );
    expect(written).toBeGreaterThanOrEqual(2); // includes re-runs of prior nodes' buckets

    const rows = await bucketsFor(nodeId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.port).toBe(8000);
    expect(rows[0]!.bucketStart.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(rows[0]!.samples).toBe(2);
    expect(rows[0]!.decodeTps).toBeCloseTo(50);
    expect(rows[0]!.ttftP95Ms).toBeCloseTo(300);
    expect(rows[0]!.queueRunning).toBeNull();
    expect(rows[1]!.port).toBe(8001);
    expect(rows[1]!.samples).toBe(2);
    expect(rows[1]!.decodeTps).toBeCloseTo(30);
    expect(rows[1]!.queueRunning).toBeCloseTo(2); // avg(2, null)
    expect(rows[1]!.kvCachePct).toBeCloseTo(20);
    expect(rows[1]!.ttftP95Ms).toBeNull();
  });

  it("recomputes llm buckets idempotently over overlapping windows", async () => {
    const { id: nodeId } = await makeNode("llm-idem");
    await seedLlm(nodeId, new Date("2026-01-15T10:00:30Z"), [port(8000, { decodeTps: 42.5 })]);

    await computeLlmBuckets(h.db, "minute", new Date("2026-01-15T09:59:00Z"), new Date("2026-01-15T10:03:00Z"));
    const first = await bucketsFor(nodeId);
    await computeLlmBuckets(h.db, "minute", new Date("2026-01-15T09:59:00Z"), new Date("2026-01-15T10:05:00Z"));
    const second = await bucketsFor(nodeId);
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
    expect(second[0]!.decodeTps).toBeCloseTo(42.5);
  });

  it("engine advances the llm watermark and skips incomplete buckets", async () => {
    const { id: nodeId } = await makeNode("llm-engine");
    await seedLlm(nodeId, new Date("2026-01-15T10:00:10Z"), [port(8000, { decodeTps: 10 })]);

    const engine = createLlmRollupEngine(h.db);
    await engine.runOnce(new Date("2026-01-15T10:03:20Z"));

    let rows = await bucketsFor(nodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucketStart.toISOString()).toBe("2026-01-15T10:00:00.000Z");

    const [wm] = await h.db.select().from(settings).where(eq(settings.key, LLM_ROLLUP_WATERMARK_KEY));
    expect((wm!.value as { minute: string }).minute).toBe("2026-01-15T10:03:00.000Z");

    // Re-run in the same minute: nothing new to compute, watermark holds.
    await engine.runOnce(new Date("2026-01-15T10:03:40Z"));
    rows = await bucketsFor(nodeId);
    expect(rows).toHaveLength(1);
  });

  it("serves per-port series from buckets; falls back to raw for 1h when absent", async () => {
    const { id: bucketedId } = await makeNode("llm-hist");
    // Anchor inside one minute: t0 and t0+5s must share a bucket or the
    // average below is flaky near minute boundaries.
    const t0 = new Date(Math.floor((Date.now() - 5 * 60_000) / 60_000) * 60_000 + 10_000);
    await seedLlm(bucketedId, t0, [
      port(8000, { decodeTps: 40, ttftP95Ms: 200 }),
      port(9001, { decodeTps: 10 }),
    ]);
    await seedLlm(bucketedId, new Date(t0.getTime() + 5_000), [port(8000, { decodeTps: 60 })]);
    await computeLlmBuckets(h.db, "minute", new Date(Date.now() - 10 * 60_000), new Date());

    const app = makeApiApp();
    const res = await request(app).get(`/api/v1/nodes/${bucketedId}/llm/history`).query({ range: "1h" });
    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe("minute");
    expect(res.body.series).toHaveLength(2);
    expect(res.body.series[0].port).toBe(8000);
    expect(res.body.series[0].points[0].decodeTps).toBeCloseTo(50); // avg(40, 60)
    expect(res.body.series[0].points[0].samples).toBe(2);
    expect(res.body.series[1].port).toBe(9001);
    expect(res.body.series[1].points[0].decodeTps).toBeCloseTo(10);

    // Raw fallback: fresh node, no buckets.
    const { id: rawId } = await makeNode("llm-hist-raw");
    await seedLlm(rawId, new Date(Date.now() - 90_000), [port(8000, { decodeTps: 40 })]);
    await seedLlm(rawId, new Date(Date.now() - 30_000), [port(8000, { decodeTps: 60 }), port(9001, { decodeTps: 10 })]);
    const raw = await request(app).get(`/api/v1/nodes/${rawId}/llm/history`).query({ range: "1h" });
    expect(raw.status).toBe(200);
    expect(raw.body.granularity).toBe("minute");
    expect(raw.body.series).toHaveLength(2); // 60 s apart → distinct minutes
    expect(raw.body.series[0].port).toBe(8000);
    expect(raw.body.series[0].points).toHaveLength(2);
    expect(raw.body.series[0].points[0].decodeTps).toBeCloseTo(40);
    expect(raw.body.series[0].points[1].decodeTps).toBeCloseTo(60);
    expect(raw.body.series[1].port).toBe(9001);
    expect(raw.body.series[1].points[0].decodeTps).toBeCloseTo(10);

    // Non-minute granularities never fall back to raw.
    const hour = await request(app).get(`/api/v1/nodes/${rawId}/llm/history`).query({ range: "24h" });
    expect(hour.status).toBe(200);
    expect(hour.body.granularity).toBe("hour");
    expect(hour.body.series).toEqual([]);
  });

  it("serves GET /llm from the ring with a DB fallback and 404s without data", async () => {
    const app = makeApiApp();
    const { id: nodeId } = await makeNode("llm-live");
    expect((await request(app).get(`/api/v1/nodes/${nodeId}/llm`)).status).toBe(404);

    await llmStore.insertLlmSnapshot(nodeId, {
      schemaVersion: SCHEMA_VERSION,
      agentVersion: "0.1.0",
      ports: [port(8000, { decodeTps: 11 })],
    });
    const fallback = await request(app).get(`/api/v1/nodes/${nodeId}/llm`);
    expect(fallback.status).toBe(200);
    expect(fallback.body.ports).toHaveLength(1);
    expect(fallback.body.ports[0].decodeTps).toBe(11);
    expect(typeof fallback.body.updatedAt).toBe("string");

    rings.pushLlm(nodeId, { serverTimeMs: 1234, ports: [port(8000, { decodeTps: 22 })] });
    const ringed = await request(app).get(`/api/v1/nodes/${nodeId}/llm`);
    expect(ringed.status).toBe(200);
    expect(ringed.body.updatedAt).toBe(new Date(1234).toISOString());
    expect(ringed.body.ports[0].decodeTps).toBe(22);

    expect((await request(app).get(`/api/v1/nodes/${randomUUID()}/llm`)).status).toBe(404);
  });

  it("persists PUT /llm-ports and delivers them via config-update after hello-ok", async () => {
    const app = makeApiApp();
    const { id: nodeId, token } = await makeNode("llm-e2e", "worker");

    const res = await request(app).put(`/api/v1/nodes/${nodeId}/llm-ports`).send({ ports: [8000, 9001] });
    expect(res.status).toBe(200);
    expect(res.body.llmPorts).toEqual([
      { port: 8000, host: "127.0.0.1" },
      { port: 9001, host: "127.0.0.1" },
    ]);

    const hub = createAgentHub({
      store,
      llmStore,
      rings,
      sse: createSseHub({ heartbeatMs: 0 }),
      getCadenceMs: () => 2000,
      serverVersion: "test",
    });
    const server = createServer();
    hub.attach(server);
    const wsPort = await listen(server);
    cleanups.push(() => {
      hub.stop();
      server.close();
      server.closeAllConnections();
    });

    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/agent-ws`);
    await opened(ws);
    ws.send(hello(token));
    const [helloOk, config] = await Promise.all([nextMessage(ws), nextMessage(ws)]);
    expect(helloOk).toMatchObject({ type: "hello-ok", nodeId });
    expect(config).toEqual({
      type: "config-update",
      cadenceMs: 2000,
      llmPorts: [
        { port: 8000, host: "127.0.0.1" },
        { port: 9001, host: "127.0.0.1" },
      ],
      llmCadenceMs: 10_000,
      llmDetectOnly: true,
      nasRoot: null,
      cacheUser: null,
    });
    ws.close();
  });

  it("pushes the derived worker cadence over a real WS when a setup is created (IRI-050)", async () => {
    const head = await makeNode("ir-ws-head", "worker"); // previously a worker — ordering pin
    const worker = await makeNode("ir-ws-worker", "standalone");
    const hub = createAgentHub({
      store,
      llmStore,
      rings,
      sse: createSseHub({ heartbeatMs: 0 }),
      getCadenceMs: () => 2000,
      serverVersion: "test",
    });
    const server = createServer();
    hub.attach(server);
    const wsPort = await listen(server);
    cleanups.push(() => {
      hub.stop();
      server.close();
      server.closeAllConnections();
    });

    const setups = createSetupsService({
      db: h.db,
      rings,
      sse: createSseHub({ heartbeatMs: 0 }),
      getNode: async (id) => (await store.get(id)) ?? null,
      getNodes: () => store.list(),
      online: () => new Set([head.id, worker.id]),
      sendToNode: (nodeId, msg) => hub.sendToNode(nodeId, msg),
      refreshNodeConfig: (nodeId) => hub.refreshConfig(nodeId),
      jobs: {
        create: async () => {
          throw new Error("unused: no transfers in this test");
        },
        cancel: async () => true,
        findModel: async () => null,
        presentNodesFor: async () => [],
      },
    });

    // Connect both agents first so pushes land on open sockets (the
    // handshakes consume hello-ok + the pre-create config-update).
    const headSock = await handshake(`ws://127.0.0.1:${wsPort}/agent-ws`, head.token);
    const workerSock = await handshake(`ws://127.0.0.1:${wsPort}/agent-ws`, worker.token);

    await setups.create({
      name: "ir-ws-cluster",
      kind: "cluster",
      model: "Roles-WS-Model",
      port: 8123,
      headNodeId: head.id,
      nodes: [{ nodeId: worker.id, role: "worker" }],
      scriptStart: "/s/start.sh",
      scriptStop: "/s/stop.sh",
      env: { modelName: false, port: false, extraArgs: "", modelPath: false },
    });

    // Worker: the pushed config-update carries the derived detect-only cadence.
    expect(await nextMessage(workerSock.ws)).toMatchObject({
      type: "config-update",
      llmCadenceMs: 10_000,
      llmDetectOnly: true,
    });
    // The head had role "worker" before the create — its FIRST push must
    // already carry the derived head cadence (role writes run before the
    // ensurePortAssigned push, IRI-050 G7).
    expect(await nextMessage(headSock.ws)).toMatchObject({
      type: "config-update",
      llmDetectOnly: false,
    });

    const roles = await h.db
      .select({ id: nodes.id, role: nodes.role })
      .from(nodes)
      .where(inArray(nodes.id, [head.id, worker.id]));
    expect(roles.find((r) => r.id === head.id)!.role).toBe("head");
    expect(roles.find((r) => r.id === worker.id)!.role).toBe("worker");
    workerSock.ws.close();
    headSock.ws.close();
  });

  it("pushes a config-update when PUT /llm-ports saves (IRI-034)", async () => {
    const refreshed: string[] = [];
    const app = makeApiApp(refreshed);
    const { id: nodeId } = await makeNode("llm-push");

    const res = await request(app).put(`/api/v1/nodes/${nodeId}/llm-ports`).send({ ports: [8000] });
    expect(res.status).toBe(200);
    expect(refreshed).toEqual([nodeId]);
  });

  it("persists agent llm passes into llm_snapshots through the hub", async () => {
    const hub = createAgentHub({
      store,
      llmStore,
      rings,
      sse: createSseHub({ heartbeatMs: 0 }),
      getCadenceMs: () => 2000,
      serverVersion: "test",
    });
    const server = createServer();
    hub.attach(server);
    const wsPort = await listen(server);
    cleanups.push(() => {
      hub.stop();
      server.close();
      server.closeAllConnections();
    });

    const { id: nodeId, token } = await makeNode("llm-ingest");
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/agent-ws`);
    await opened(ws);
    ws.send(hello(token));
    await Promise.all([nextMessage(ws), nextMessage(ws)]);
    ws.send(makeLlmMsg([port(8000, { decodeTps: 33 })]));
    await waitUntil(async () => {
      const rows = await h.db.select().from(llmSnapshots).where(eq(llmSnapshots.nodeId, nodeId));
      return rows.length === 1;
    });
    const [row] = await h.db.select().from(llmSnapshots).where(eq(llmSnapshots.nodeId, nodeId));
    const payload: unknown = row!.payload;
    expect(typeof payload === "object" && payload !== null && "ports" in payload).toBe(true);
    if (typeof payload === "object" && payload !== null && "ports" in payload) {
      expect((payload.ports as LlmPortSnapshot[])[0]!.decodeTps).toBe(33);
    }
    ws.close();
  });

  it("retention prunes raw llm snapshots and buckets per policy (runs last)", async () => {
    const { id: nodeId } = await makeNode("llm-retain");
    await seedLlm(nodeId, new Date(Date.now() - 30 * 3_600_000), [port(8000, { decodeTps: 1 })]); // beyond 24 h
    await seedLlm(nodeId, new Date(Date.now() - 1 * 3_600_000), [port(8000, { decodeTps: 2 })]); // kept
    await h.db.insert(llmBuckets).values([
      { nodeId, port: 8000, granularity: "minute", bucketStart: new Date(Date.now() - 8 * 86_400_000), samples: 1 },
      { nodeId, port: 8000, granularity: "minute", bucketStart: new Date(Date.now() - 3_600_000), samples: 2 },
    ]);

    const result = await runLlmRetention(llmStore, { rawHours: 24, minuteKeepDays: 7, hourKeepDays: 90, dayKeepDays: 365 });
    expect(result.raw).toBeGreaterThanOrEqual(1);
    expect(result.minute).toBeGreaterThanOrEqual(1);

    const rows = await bucketsFor(nodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucketStart.getTime()).toBeGreaterThan(Date.now() - 7 * 86_400_000);
    const raw = await h.db.select().from(llmSnapshots).where(eq(llmSnapshots.nodeId, nodeId));
    expect(raw).toHaveLength(1);
    expect(raw[0]!.serverTime.getTime()).toBeGreaterThan(Date.now() - 24 * 3_600_000);
  });
});
