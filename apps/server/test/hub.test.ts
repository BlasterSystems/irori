import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
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
    cadenceMs: 2000,
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

const hello = (token: string, agentVersion = "0.1.0") =>
  JSON.stringify({ type: "hello", schemaVersion: SCHEMA_VERSION, agentVersion, token, hostname: "spark1" });

const snapshotMsg = (overrides: Partial<HardwareSnapshot> = {}) =>
  JSON.stringify({ type: "snapshot", snapshot: makeSnapshot(overrides) });

async function authenticate(url: string, token: string) {
  const ws = new WebSocket(url);
  await opened(ws);
  ws.send(hello(token));
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
});
