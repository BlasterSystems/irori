import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { SCHEMA_VERSION, type HardwareSnapshot } from "@irori/core";
import { createAgentHub, type AgentHubDeps } from "../src/hub.js";
import { createRings } from "../src/rings.js";
import {
  listen,
  makeFakeStore,
  makeSnapshot,
  makeSseSpy,
  nextClose,
  nextMessage,
  opened,
  sleep,
} from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

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

const hello = (token: string, agentVersion = "0.1.0", bundleSha256?: string) =>
  JSON.stringify({
    type: "hello",
    schemaVersion: SCHEMA_VERSION,
    agentVersion,
    token,
    hostname: "spark1",
    // IR-260: pre-IR-260 agents omit the field entirely.
    ...(bundleSha256 === undefined ? {} : { bundleSha256 }),
  });

it("carries the hub modelctl pin in the hello config-update (IR-105)", async () => {
  const { url, created } = await setup({ getModelctlPin: async () => "0.23.0" });
  const ws = new WebSocket(url);
  await opened(ws);
  ws.send(hello(created.token));
  const reply = nextMessage(ws);
  const config = nextMessage(ws);
  expect(await reply).toMatchObject({ type: "hello-ok" });
  expect(await config).toMatchObject({ type: "config-update", modelctlPin: "0.23.0" });
  ws.close();
});

const snapshotMsg = (overrides: Partial<HardwareSnapshot> = {}) =>
  JSON.stringify({ type: "snapshot", snapshot: makeSnapshot(overrides) });

it("settles job-done only after the preceding job-output has landed (IR-106)", async () => {
  const jobId = randomUUID();
  let outputLanded = false;
  const dones: boolean[] = [];
  const { url, created } = await setup({
    jobEvents: {
      onOutput: async () => {
        await sleep(50);
        outputLanded = true;
      },
      onDone: async () => {
        dones.push(outputLanded);
      },
      onCatalog: async () => {},
    },
  });
  const ws = await authenticate(url, created.token);
  // Back-to-back: without the per-socket job chain the settle would race the
  // insert and the models-inventory report would silently never persist.
  ws.send(JSON.stringify({ type: "job-output", jobId, seq: 1, line: "{}" }));
  ws.send(JSON.stringify({ type: "job-done", jobId, status: "succeeded", exitCode: 0 }));
  await waitUntil(() => dones.length > 0);
  expect(dones).toEqual([true]);
  ws.close();
});

async function authenticate(url: string, token: string, bundleSha256?: string) {
  const ws = new WebSocket(url);
  await opened(ws);
  ws.send(hello(token, "0.1.0", bundleSha256));
  // Attach both listeners before awaiting: hello-ok and config-update are sent
  // back-to-back and can land in one TCP segment.
  const reply = nextMessage(ws);
  const config = nextMessage(ws);
  expect(await reply).toMatchObject({ type: "hello-ok" });
  await config; // asserted in detail by the llm tests
  return ws;
}

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await sleep(10);
  expect(cond()).toBe(true);
}

describe("agent hub", () => {
  it("rejects a bad token with an error frame and close", async () => {
    const { url } = await setup();
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(hello("bogus-token"));
    expect(await nextMessage(ws)).toMatchObject({ type: "error" });
    await nextClose(ws);
  });

  it("refuses unsupported agent versions", async () => {
    const { url } = await setup();
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(hello("token-1", "0.0.9"));
    expect(await nextMessage(ws)).toMatchObject({ type: "error", message: "unsupported agent version: 0.0.9" });
    await nextClose(ws);
  });

  it("records the hello's bundle hash and clears it for old agents (IR-260)", async () => {
    const { url, created, fake } = await setup();
    const seenHashes: Array<string | null | undefined> = [];
    fake.store.markSeen = async (_nodeId: string, _agentVersion: string, bundleSha256?: string | null) => {
      seenHashes.push(bundleSha256);
    };
    const ws = await authenticate(url, created.token, "a".repeat(64));
    await waitUntil(() => seenHashes.length > 0);
    expect(seenHashes[0]).toBe("a".repeat(64));
    ws.close();

    // A pre-IR-260 agent sends no field: the hub clears the stored hash
    // instead of leaving a stale generation behind.
    const ws2 = await authenticate(url, created.token);
    await waitUntil(() => seenHashes.length > 1);
    expect(seenHashes[1]).toBeNull();
    ws2.close();
  });

  it("closes on an invalid first frame", async () => {
    const { url } = await setup();
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send("}{ not json");
    expect(await nextMessage(ws)).toMatchObject({ type: "error" });
    await nextClose(ws);
  });

  it("rejects a snapshot arriving before hello", async () => {
    const { url } = await setup();
    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(snapshotMsg());
    expect(await nextMessage(ws)).toMatchObject({ type: "error", message: "first frame must be hello" });
    await nextClose(ws);
  });

  it("completes the hello handshake and marks the node online", async () => {
    const { url, created, events, hub } = await setup();
    const ws = await authenticate(url, created.token);
    expect(await hub.online().has(created.id)).toBe(true);
    expect(events[0]).toMatchObject({ type: "node-online", nodeId: created.id, agentVersion: "0.1.0" });
    ws.close();
    await nextClose(ws);
    await waitUntil(() => !hub.online().has(created.id));
    expect(hub.online().has(created.id)).toBe(false);
  });

  it("keeps a reconnected node online when a stale socket closes late", async () => {
    const { url, created, hub } = await setup();
    const stale = await authenticate(url, created.token);
    const fresh = await authenticate(url, created.token); // hello overwrites the registration
    expect(hub.online().has(created.id)).toBe(true);
    // The stale socket's late close must not deregister the fresh one
    // (half-open reconnect: the agent never notices the ghost-offline).
    stale.close();
    await nextClose(stale);
    await sleep(50);
    expect(hub.online().has(created.id)).toBe(true);
    expect(hub.sendToNode(created.id, { type: "ping" })).toBe(true);
    fresh.close();
    await nextClose(fresh);
    await waitUntil(() => !hub.online().has(created.id));
  });

  it("answers ping with pong", async () => {
    const { url, created } = await setup();
    const ws = await authenticate(url, created.token);
    ws.send(JSON.stringify({ type: "ping", t: 42 }));
    expect(await nextMessage(ws)).toEqual({ type: "pong", t: 42 });
    ws.close();
  });

  it("lands snapshots in the ring, SSE, and the store", async () => {
    const { url, created, rings, events, fake } = await setup();
    const ws = await authenticate(url, created.token);
    const snapshot = makeSnapshot();
    ws.send(JSON.stringify({ type: "snapshot", snapshot }));
    await sleep(20);
    expect(rings.latest(created.id)).toEqual(snapshot);
    expect(events).toContainEqual(expect.objectContaining({ type: "snapshot", nodeId: created.id, snapshot }));
    expect(fake.snapshots).toEqual([{ nodeId: created.id, payload: snapshot }]);
    ws.close();
  });

  it("throttles markSeen to one call per 30 s per node", async () => {
    const { url, created, fake } = await setup();
    const ws = await authenticate(url, created.token);
    for (let i = 0; i < 3; i++) ws.send(snapshotMsg());
    await sleep(40);
    expect(fake.seen).toHaveLength(1);
    ws.close();
  });

  it("buffers snapshots while the DB is down and flushes on recovery", async () => {
    const { url, created, fake } = await setup();
    const ws = await authenticate(url, created.token);
    fake.setFailInserts(true);
    for (let i = 0; i < 3; i++) ws.send(snapshotMsg({ timestampMs: i }));
    await sleep(80);
    expect(fake.snapshots).toEqual([]);
    fake.setFailInserts(false);
    await sleep(80);
    expect(fake.snapshots).toHaveLength(3);
    ws.close();
  });

  it("caps the failure buffer at 1000, dropping oldest", async () => {
    const { url, created, fake, rings } = await setup();
    const ws = await authenticate(url, created.token);
    fake.setFailInserts(true);
    const total = 1005;
    for (let i = 0; i < total; i++) ws.send(snapshotMsg({ timestampMs: i }));
    const deadline = Date.now() + 2000;
    while (rings.latest(created.id)?.timestampMs !== total - 1 && Date.now() < deadline) await sleep(10);
    expect(rings.latest(created.id)?.timestampMs).toBe(total - 1);
    fake.setFailInserts(false);
    const flushDeadline = Date.now() + 2000;
    while (fake.snapshots.length < 1000 && Date.now() < flushDeadline) await sleep(10);
    expect(fake.snapshots).toHaveLength(1000);
    expect(fake.snapshots[0]?.payload).toMatchObject({ timestampMs: total - 1000 });
    ws.close();
  });

  it("fires jobEvents.onHello on every authenticated hello (IRI-012)", async () => {
    const hellos: Array<{ nodeId: string; agentVersion: string }> = [];
    const { url, created } = await setup({
      jobEvents: {
        onOutput: async () => {},
        onDone: async () => {},
        onCatalog: async () => {},
        onHello: async (nodeId, agentVersion) => {
          hellos.push({ nodeId, agentVersion });
        },
      },
    });
    const ws = await authenticate(url, created.token);
    await waitUntil(() => hellos.length > 0);
    expect(hellos).toEqual([{ nodeId: created.id, agentVersion: "0.1.0" }]);
    ws.close();
  });

  it("carries the global HF token in config-update frames (IRI-019)", async () => {
    let token: string | null = "hf_x";
    let failRead = false;
    const { url, created } = await setup({
      getHfToken: async () => {
        if (failRead) throw new Error("db down");
        return token;
      },
    });

    const handshakeConfig = async () => {
      const ws = new WebSocket(url);
      await opened(ws);
      ws.send(hello(created.token));
      const reply = nextMessage(ws);
      const config = nextMessage(ws);
      expect(await reply).toMatchObject({ type: "hello-ok" });
      ws.close();
      return config;
    };

    // string = set
    expect(await handshakeConfig()).toMatchObject({ hfToken: "hf_x" });
    // null = clear
    token = null;
    expect(await handshakeConfig()).toMatchObject({ hfToken: null });
    // hub read failure → the .catch omits the key so the agent keeps its
    // current token (here "hf_x" from the first handshake)
    failRead = true;
    const cfg = (await handshakeConfig()) as object;
    expect("hfToken" in cfg).toBe(false);
  });

  it("carries the node's cache user in config-update frames (IR-101)", async () => {
    const { url, created, fake } = await setup();
    await fake.store.patch(created.id, { cacheUser: "piresbruno" });

    const ws = new WebSocket(url);
    await opened(ws);
    ws.send(hello(created.token));
    const reply = nextMessage(ws);
    const config = nextMessage(ws);
    expect(await reply).toMatchObject({ type: "hello-ok" });
    expect(await config).toMatchObject({ cacheUser: "piresbruno" });
    ws.close();
  });
});

it("survives an oversized agent frame: logs, closes 1009, keeps serving (IR-177)", async () => {
  const { url, created } = await setup({ maxFrameBytes: 1024 });
  const ws = new WebSocket(url);
  await opened(ws);
  ws.send(hello(created.token));
  expect(await nextMessage(ws)).toMatchObject({ type: "hello-ok" });
  await nextMessage(ws); // config-update
  // A frame over maxPayload makes the ws receiver emit 'error' on the server
  // socket; without the IR-177 handler this became an unhandled 'error'
  // event and killed the whole hub process (2026-11-04 incident).
  ws.send("x".repeat(4096));
  const closeCode = await new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  expect(closeCode).toBe(1009);
  // The hub is still alive and accepting new agents.
  const ws2 = new WebSocket(url);
  await opened(ws2);
  ws2.send(hello(created.token));
  expect(await nextMessage(ws2)).toMatchObject({ type: "hello-ok" });
  ws2.close();
});
