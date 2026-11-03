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
import { splitTokens } from "../src/usage-store.js";
import { type UsageClients, type ClientIdentityInfo } from "../src/usage-clients.js";
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
      getCadenceMs: () => 2000,
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

// ---- Hub: log-batch routing (IRI-078, fake store, real frame chain) ----

import { logEventSchema, type LogEvent } from "@irori/core";

let logSeq = 0;
function logEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  logSeq += 1;
  return logEventSchema.parse({
    eventId: `00000000-0000-4000-8000-${String(logSeq).padStart(12, "0")}`,
    ts: 1_700_000_000_000 + logSeq,
    scope: "setup",
    setupId: null,
    runId: null,
    jobId: null,
    level: "info",
    source: "engine",
    seq: logSeq,
    line: `engine line ${logSeq}`,
    ...overrides,
  });
}

describe("agent hub log batches", () => {
  async function setup(onBatch: (nodeId: string, events: LogEvent[], dropped: number) => Promise<{ inserted: number; latestId: string | null } | null>) {
    const fake = makeFakeStore();
    const created = await fake.store.create({ name: "spark1", kind: "spark", role: "head", host: "spark1.local" });
    const { events, sse } = makeSseSpy();
    const batches: Array<{ nodeId: string; events: LogEvent[]; dropped: number }> = [];
    const deps: AgentHubDeps = {
      store: fake.store,
      llmStore: fake.llmStore,
      rings: createRings(),
      sse,
      getCadenceMs: () => 2000,
      serverVersion: "test-server",
      jobEvents: {
        onOutput: async () => null,
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
      usageEvents: { onBatch: async () => true },
      logEvents: {
        onBatch: async (nodeId, batch, dropped) => {
          batches.push({ nodeId, events: batch, dropped });
          return onBatch(nodeId, batch, dropped);
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

  it("acks log batches with the sender's node and pulses the Logs view", async () => {
    const { created, events, batches, url } = await setup(async () => ({ inserted: 2, latestId: "42" }));
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(hello(created.token));
    await nextMessage(ws); // hello-ok
    await nextMessage(ws); // config-update

    const batch = [logEvent(), logEvent()];
    ws.send(JSON.stringify({ type: "log-batch", schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", events: batch, dropped: 7 }));
    const ack = await nextMessage(ws);
    expect(ack).toEqual({ type: "log-batch-ack", ids: batch.map((e) => e.eventId) });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.nodeId).toBe(created.id);
    expect(batches[0]!.dropped).toBe(7);
    expect(batches[0]!.events).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 20));
    const pulses = events.filter((e) => e.type === "log-update");
    expect(pulses).toHaveLength(1);
    expect(pulses[0]).toMatchObject({ nodeId: created.id, count: 2, latestId: "42" });
    ws.close();
  });

  it("does not ack when the store is unavailable (agent redelivers)", async () => {
    const { created, url } = await setup(async () => null);
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(hello(created.token));
    await nextMessage(ws);
    await nextMessage(ws);

    ws.send(JSON.stringify({ type: "log-batch", schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", events: [logEvent()], dropped: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    // No ack frame, no pulse — the agent's durable buffer keeps the rows.
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
    agents: track("agents", () => ({ range: "24h", groups: [] })),
    tools: track("tools", () => ({ range: "24h", tools: [], series: [] })),
    pruneRaw: track("pruneRaw", () => 0),
    pruneBuckets: track("pruneBuckets", () => 0),
  } as unknown as UsageStore;
  return { store, calls };
}

function fakeUsageClients(): { clients: UsageClients; identities: ClientIdentityInfo[] } {
  const identities: ClientIdentityInfo[] = [
    { id: "00000000-0000-4000-8000-0000000000c1", name: "omp", project: "irori", agentType: "main", keyHash: "a".repeat(64), createdAtMs: 1 },
  ];
  const clients: UsageClients = {
    list: async () => identities,
    create: async (input) => {
      const created: ClientIdentityInfo = {
        id: `00000000-0000-4000-8000-${String(identities.length + 1).padStart(12, "0")}`,
        name: input.name,
        project: input.project ?? null,
        agentType: input.agentType ?? null,
        keyHash: "b".repeat(64),
        createdAtMs: 2,
      };
      identities.push(created);
      return { ...created, key: "irn_issued_once" };
    },
    remove: async (id) => {
      const i = identities.findIndex((x) => x.id === id);
      if (i === -1) return false;
      identities.splice(i, 1);
      return true;
    },
  };
  return { clients, identities };
}

function makeAppWithUsage(usage: UsageStore | null, clients: UsageClients | null = null) {
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
    getUsageClients: () => clients,
    getDownloads: () => null,
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

describe("tool attribution splits (IR-54)", () => {
  it("splits by weight with exact sums (largest remainder)", () => {
    expect(splitTokens(100, [10, 6])).toEqual([63, 37]); // 62.5/37.5, tie → first
    expect(splitTokens(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(splitTokens(100, [0, 0])).toEqual([50, 50]); // equal split on no signal
    expect(splitTokens(0, [5, 5])).toEqual([0, 0]);
    expect(splitTokens(7, [1])).toEqual([7]);
    expect(splitTokens(5, [])).toEqual([]);
  });
});

describe("client identity API (IR-55)", () => {
  it("serves the agents view and forwards client filters", async () => {
    const { store, calls } = fakeUsageStore();
    const app = makeAppWithUsage(store);
    expect((await request(app).get("/api/v1/usage/agents?range=24h")).status).toBe(200);
    expect((await request(app).get("/api/v1/usage/requests?range=24h&project=irori&agentType=subagent")).status).toBe(200);
    // Unknown agent types are ignored (no 400 — a v1 view cannot regress).
    expect((await request(app).get("/api/v1/usage/requests?range=24h&agentType=weird")).status).toBe(200);
    const agentsCall = calls.find((c) => c.method === "agents");
    expect(agentsCall).toBeDefined();
    expect((await request(app).get("/api/v1/usage/tools?range=24h&model=GLM")).status).toBe(200);
    expect((await request(app).get("/api/v1/usage/tools?range=24h&project=irori&agentType=main")).status).toBe(200);
    expect(calls.filter((c) => c.method === "tools")).toHaveLength(2);
    expect(calls.find((c) => c.method === "tools" && c.args !== null && typeof c.args === "object" && "project" in (c.args as object))).toBeDefined();
    const requestsCalls = calls.filter((c) => c.method === "requests");
    expect(requestsCalls[0]).toMatchObject({ args: expect.objectContaining({ project: "irori", agentType: "subagent" }) });
    // The ignored agentType never reaches the store as a filter value.
    expect(requestsCalls.at(-1)).toMatchObject({ args: expect.objectContaining({ agentType: undefined, project: undefined }) });
  });

  it("manages client identities (list, create with one-time key, delete)", async () => {
    const { clients, identities } = fakeUsageClients();
    const app = makeAppWithUsage(fakeUsageStore().store, clients);
    const listed = await request(app).get("/api/v1/usage/clients");
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toHaveLength(1);

    const created = await request(app).post("/api/v1/usage/clients").send({ name: "codex", project: "carrigo", agentType: "subagent" });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe("irn_issued_once"); // shown exactly once
    expect(created.body.keyHash).toHaveLength(64);
    expect(identities).toHaveLength(2);

    expect((await request(app).post("/api/v1/usage/clients").send({ name: "" })).status).toBe(400);
    expect((await request(app).post("/api/v1/usage/clients").send({ name: "x", agentType: "nope" })).status).toBe(400);

    const removed = await request(app).delete(`/api/v1/usage/clients/${identities[0]!.id}`);
    expect(removed.status).toBe(200);
    expect((await request(app).delete("/api/v1/usage/clients/00000000-0000-4000-8000-000000000099")).status).toBe(404);
  });

  it("answers 503 for identity routes while degraded", async () => {
    const app = makeAppWithUsage(fakeUsageStore().store, null);
    expect((await request(app).get("/api/v1/usage/clients")).status).toBe(503);
    expect((await request(app).post("/api/v1/usage/clients").send({ name: "x" })).status).toBe(503);
  });
});
