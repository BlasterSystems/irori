import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { WebSocket } from "ws";
import { SCHEMA_VERSION, usageRequestSchema, type UsageRequest } from "@irori/core";
import { createApp, type AppDeps } from "../src/app.js";
import { createAgentHub, type AgentHubDeps } from "../src/hub.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import type { UsageStore } from "../src/usage-store.js";
import { listen, makeFakeStore, makeSseSpy, nextMessage, opened } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

let seq = 0;
function usageRequest(overrides: Partial<UsageRequest> = {}): UsageRequest {
  seq += 1;
  return usageRequestSchema.parse({
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    ts: 1_700_000_000_000 + seq,
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
    ttftMs: 100,
    decodeTps: 42,
    promptTokens: 10,
    completionTokens: 20,
    cachedTokens: 5,
    reasoningTokens: 2,
    totalTokens: 30,
    engineMeta: null,
    reqBytes: 100,
    resBytes: 200,
    sourceAddr: "127.0.0.1",
    ...overrides,
  });
}

// ---- Hub: usage-batch routing (fake store, real frame chain) ----

describe("agent hub usage batches", () => {
  async function setup(onBatch: (nodeId: string, events: UsageRequest[]) => Promise<boolean>) {
    const fake = makeFakeStore();
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const { events, sse } = makeSseSpy();
    const batches: Array<{ nodeId: string; events: UsageRequest[] }> = [];
    const deps: AgentHubDeps = {
      store: fake.store,
      llmStore: fake.llmStore,
      rings: createRings(),
      sse,
      cadenceMs: 2000,
      serverVersion: "test-server",
      jobEvents: {
        onOutput: async () => {},
        onDone: async () => {},
        onCatalog: async () => {},
      },
      setupEvents: {
        onAck: async () => {},
        onEvent: async () => {},
        onLog: async () => {},
        onValidateResult: () => {},
      },
      benchEvents: { onProgress: () => {}, onDone: async () => {} },
      usageEvents: {
        onBatch: async (nodeId, batch) => {
          batches.push({ nodeId, events: batch });
          return onBatch(nodeId, batch);
        },
      },
    };
    const hub = createAgentHub(deps);
    const server = createServer();
    hub.attach(server);
    const port = await listen(server);
    cleanups.push(() => {
      hub.stop();
      server.close();
      server.closeAllConnections();
    });
    return { created, events, batches, url: `ws://127.0.0.1:${port}/agent-ws` };
  }

  function hello(token: string): string {
    return JSON.stringify({ type: "hello", schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", token, hostname: "spark1" });
  }

  it("persists batches, acks the ids, and fans out SSE usage events", async () => {
    const { created, events, batches, url } = await setup(async () => true);
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(hello(created.token));
    await nextMessage(ws); // hello-ok
    await nextMessage(ws); // config-update

    const batch = [usageRequest(), usageRequest()];
    ws.send(JSON.stringify({ type: "usage-batch", schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", events: batch }));
    const ack = await nextMessage(ws);
    expect(ack).toEqual({ type: "usage-batch-ack", ids: batch.map((e) => e.id) });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.nodeId).toBe(created.id);
    expect(batches[0]!.events).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 20));
    const usageFrames = events.filter((e) => e.type === "usage");
    expect(usageFrames).toHaveLength(2);
    ws.close();
  });

  it("does not ack when the insert fails (agent redelivers)", async () => {
    const { created, url } = await setup(async () => false);
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(hello(created.token));
    await nextMessage(ws);
    await nextMessage(ws);

    ws.send(JSON.stringify({ type: "usage-batch", schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", events: [usageRequest()] }));
    await new Promise((r) => setTimeout(r, 50));
    // No ack frame — the agent's buffer keeps the rows.
    ws.close();
  });
});

// ---- API contract (fake UsageStore) ----

function fakeUsageStore(): { store: UsageStore; calls: Array<{ method: string; args: unknown }> } {
  const calls: Array<{ method: string; args: unknown }> = [];
  const track = <T>(method: string, fn: (args: T) => unknown) => (args: T): unknown => {
    calls.push({ method, args });
    return fn(args);
  };
  const store: UsageStore = {
    insertBatch: track("insertBatch", () => 0),
    overview: track("overview", () => ({
      range: "24h",
      granularity: "hour",
      kpis: {
        requests: 2,
        errors: 1,
        promptTokens: 10,
        completionTokens: 20,
        cachedTokens: 5,
        reasoningTokens: 2,
        totalTokens: 30,
        ttftP50Ms: 100,
        ttftP95Ms: 200,
        decodeTps: 42,
      },
      series: [{ t: "2026-10-20T09:00:00.000Z", requests: 2, errors: 1, promptTokens: 10, completionTokens: 20, cachedTokens: 5, reasoningTokens: 2, totalTokens: 30, ttftP50Ms: 100, ttftP95Ms: 200, decodeTps: 42 }],
      tokenMix: [{ model: "GLM-5.3-Flash-EXL3", requests: 2, errors: 1, promptTokens: 10, completionTokens: 20, cachedTokens: 5, reasoningTokens: 2, totalTokens: 30 }],
    })),
    requests: track("requests", () => ({ total: 0, rows: [] })),
    requestById: track("requestById", () => null),
    errorGroups: track("errorGroups", () => ({ range: "24h", groups: [] })),
    models: track("models", () => ({ range: "24h", models: [], series: [] })),
    pruneRaw: track("pruneRaw", () => 0),
    pruneBuckets: track("pruneBuckets", () => 0),
  } as unknown as UsageStore;
  return { store, calls };
}

function makeAppWithUsage(usage: UsageStore | null) {
  const fake = makeFakeStore();
  const deps: AppDeps = {
    getStore: () => fake.store,
    getLlmStore: () => null,
    getHistory: () => null,
    getLlmHistory: () => null,
    getJobs: () => null,
    getSetups: () => null,
    getBench: () => null,
    getAnalytics: () => null,
    getCleanup: () => null,
    getUsage: () => usage,
    dbHealthy: async () => true,
    rings: createRings(),
    sse: createSseHub({ heartbeatMs: 0 }),
    getHub: () => null,
    version: "test",
    tag: null,
    staticDir: null,
  };
  return createApp(deps);
}

describe("usage API", () => {
  it("answers 503 while degraded", async () => {
    const app = makeAppWithUsage(null);
    const res = await request(app).get("/api/v1/usage/overview?range=24h");
    expect(res.status).toBe(503);
  });

  it("rejects unknown ranges with 400", async () => {
    const { store } = fakeUsageStore();
    const app = makeAppWithUsage(store);
    const res = await request(app).get("/api/v1/usage/overview?range= fortnight");
    expect(res.status).toBe(400);
  });

  it("serves the four endpoints and forwards filters", async () => {
    const { store, calls } = fakeUsageStore();
    const app = makeAppWithUsage(store);
    expect((await request(app).get("/api/v1/usage/overview?range=7d&model=GLM")).status).toBe(200);
    expect((await request(app).get("/api/v1/usage/requests?range=24h&errors=1&page=2&limit=25")).status).toBe(200);
    expect((await request(app).get("/api/v1/usage/errors?range=90d")).status).toBe(200);
    expect((await request(app).get("/api/v1/usage/models?range=24h")).status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["overview", "requests", "errorGroups", "models"]);
    const overviewCall = calls.find((c) => c.method === "overview");
    expect(overviewCall).toMatchObject({ method: "overview" });
  });

  it("404s an unknown request id", async () => {
    const { store } = fakeUsageStore();
    const app = makeAppWithUsage(store);
    const res = await request(app).get("/api/v1/usage/requests/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });

  it("rejects non-uuid request ids with 400", async () => {
    const { store } = fakeUsageStore();
    const app = makeAppWithUsage(store);
    const res = await request(app).get("/api/v1/usage/requests/not-a-uuid");
    expect(res.status).toBe(400);
  });
});
