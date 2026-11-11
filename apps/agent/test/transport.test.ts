import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { agentMsgSchema, llmMsgSchema, snapshotMsgSchema } from "@irori/core";
import type { AgentMsg, HardwareSnapshot, HelloMsg, LlmMsg, LlmPortSnapshot, SnapshotMsg } from "@irori/core";
import { AgentTransport } from "../src/transport.js";
import type { AgentTransportOptions } from "../src/transport.js";

const BASE_TS = 1_700_000_000_000;

interface FakeServer {
  url: string;
  readonly hellos: HelloMsg[];
  readonly frames: AgentMsg[];
  broadcast(msg: unknown): void;
  kickAll(): void;
  close(): Promise<void>;
}

/** Local http server + ws upgrade endpoint implementing the server side. */
async function startFakeServer(helloCadenceMs: number, opts: { noPong?: boolean } = {}): Promise<FakeServer> {
  const hellos: HelloMsg[] = [];
  const frames: AgentMsg[] = [];
  const connections: WebSocket[] = [];

  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    connections.push(ws);
    ws.on("message", (data) => {
      const parsed = agentMsgSchema.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      frames.push(parsed.data);
      if (parsed.data.type === "ping" && !opts.noPong) {
        // The real hub pongs; without it the transport's zombie detection
        // would terminate the socket mid-test.
        ws.send(JSON.stringify({ type: "pong", t: parsed.data.t }));
      }
      if (parsed.data.type === "hello") {
        hellos.push(parsed.data);
        ws.send(
          JSON.stringify({
            type: "hello-ok",
            nodeId: randomUUID(),
            cadenceMs: helloCadenceMs,
            serverVersion: "test-server",
          }),
        );
      }
    });
  });

  http.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const listening = Promise.withResolvers<void>();
  http.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = http.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}`,
    hellos,
    frames,
    broadcast(msg: unknown) {
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      }
    },
    kickAll() {
      for (const ws of connections) ws.terminate();
    },
    async close() {
      for (const ws of connections) ws.terminate();
      const wssClosed = Promise.withResolvers<void>();
      const httpClosed = Promise.withResolvers<void>();
      wss.close(() => wssClosed.resolve());
      http.close(() => httpClosed.resolve());
      await Promise.all([wssClosed.promise, httpClosed.promise]);
    },
  };
}

function fakeSnapshotAt(seq: number): HardwareSnapshot {
  return {
    schemaVersion: 1,
    agentVersion: "0.0.0-test",
    hostname: "test-host",
    transport: "ws",
    timestampMs: BASE_TS + seq,
    cpu: {
      model: "Test CPU",
      cores: 4,
      usagePct: 42,
      tempC: null,
      packagePowerW: null,
    },
    memory: {
      totalBytes: 8 * 1024 ** 3,
      usedBytes: 4 * 1024 ** 3,
      swapTotalBytes: null,
      swapUsedBytes: null,
    },
    unifiedMemory: null,
    storage: [],
    network: [],
    memoryBandwidth: null,
    kernel: null,
    gpus: [],
  };
}

let seq = 0;
function makeTransport(overrides: Partial<AgentTransportOptions> = {}): AgentTransport {
  return new AgentTransport({
    token: "test-token",
    hostname: "test-host",
    agentVersion: "0.0.0-test",
    schemaVersion: 1,
    cadenceMs: 10_000,
    collect: async () => fakeSnapshotAt(++seq),
    reconnectBaseMs: 20,
    pingIntervalMs: 50,
    log: () => {},
    ...overrides,
  });
}

function snapshots(server: FakeServer): SnapshotMsg[] {
  return server.frames.filter((f): f is SnapshotMsg => f.type === "snapshot");
}

function llmFrames(server: FakeServer): LlmMsg[] {
  return server.frames.filter((f): f is LlmMsg => f.type === "llm");
}

function fakeLlmPort(port: number, decodeTps: number): LlmPortSnapshot {
  return {
    port,
    host: "127.0.0.1",
    backend: "vllm",
    detected: true,
    model: "meta-llama/Llama-3.1-8B",
    tokens: null,
    decodeTps,
    prefillTps: null,
    queueRunning: null,
    queueWaiting: null,
    kvCachePct: null,
    ttftP95Ms: null,
    e2eP95Ms: null,
    itlP95Ms: null,
    engineMeta: null,
    probedAtMs: BASE_TS,
  };
}

let teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  const fns = teardown.reverse();
  teardown = [];
  for (const fn of fns) await fn();
});

it("reports scopeIsolation in the hello when the host supports scopes (ADR-0017)", async () => {
  const server = await startFakeServer(30);
  teardown.push(server.close);
  const transport = makeTransport({ getScopeIsolation: () => true });
  transport.connect(server.url);
  teardown.push(() => transport.stop());
  await vi.waitFor(() => expect(server.hellos).toHaveLength(1));
  expect(server.hellos[0]!.scopeIsolation).toBe(true);
});

it("performs the hello handshake, then sends schema-valid snapshots at the negotiated cadence", async () => {
  const server = await startFakeServer(30);
  teardown.push(server.close);
  const transport = makeTransport();
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(server.hellos).toHaveLength(1));
  expect(server.hellos[0]).toMatchObject({
    type: "hello",
    schemaVersion: 1,
    agentVersion: "0.0.0-test",
    token: "test-token",
    hostname: "test-host",
  });
  // ADR-0017: absent unless the host reports scope support.
  expect(server.hellos[0]!.scopeIsolation).toBeUndefined();

  await vi.waitFor(() => expect(transport.getNodeId()).not.toBeNull());
  expect(transport.getCadenceMs()).toBe(30);

  await vi.waitFor(
    () => expect(snapshots(server).length).toBeGreaterThanOrEqual(3),
    { timeout: 5000 },
  );
  const parsed = snapshots(server).map((f) => snapshotMsgSchema.parse(f));
  expect(parsed[0]!.snapshot.cpu.model).toBe("Test CPU");
  for (let i = 1; i < parsed.length; i++) {
    expect(parsed[i]!.snapshot.timestampMs).toBeGreaterThan(parsed[i - 1]!.snapshot.timestampMs);
  }
});

it("applies config-update cadence changes", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const transport = makeTransport();
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  expect(transport.getCadenceMs()).toBe(60_000);
  expect(snapshots(server)).toHaveLength(0);

  server.broadcast({ type: "config-update", cadenceMs: 25 });
  await vi.waitFor(() => expect(transport.getCadenceMs()).toBe(25));

  await vi.waitFor(() => expect(snapshots(server).length).toBeGreaterThanOrEqual(3), {
    timeout: 5000,
  });
});

it("buffers snapshots while disconnected (drop-oldest) and flushes them after reconnect", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);

  const pending: Array<() => void> = [];
  let localSeq = 0;
  const transport = new AgentTransport({
    token: "test-token",
    hostname: "test-host",
    agentVersion: "0.0.0-test",
    schemaVersion: 1,
    cadenceMs: 60_000,
    collect: () => {
      const gated = Promise.withResolvers<HardwareSnapshot>();
      pending.push(() => gated.resolve(fakeSnapshotAt(++localSeq)));
      return gated.promise;
    },
    maxBufferedSnapshots: 2,
    // Slow enough that the disconnected window is observably long.
    reconnectBaseMs: 500,
    log: () => {},
  });
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));

  server.kickAll();
  await vi.waitFor(() => expect(transport.isReady()).toBe(false));

  const sends = [transport.sendSnapshot(), transport.sendSnapshot(), transport.sendSnapshot()];
  expect(pending).toHaveLength(3);
  for (const release of pending) release();
  await Promise.all(sends);
  expect(transport.getBufferedCount()).toBe(2);

  await vi.waitFor(() => expect(server.hellos).toHaveLength(2), { timeout: 5000 });
  await vi.waitFor(() => {
    expect(snapshots(server).map((s) => s.snapshot.timestampMs)).toEqual([
      BASE_TS + 2,
      BASE_TS + 3,
    ]);
  });
});

it("logs a server error frame and keeps the connection ready", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const logs: string[] = [];
  const transport = makeTransport({ log: (m) => logs.push(m) });
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  server.broadcast({ type: "error", message: "rejected: bad fleet" });

  // The socket must survive a plain error frame: closing here would drop
  // in-flight job output. Only a fatal auth rejection should reconnect.
  // Real delay required: we assert the ABSENCE of a reconnect over live
  // sockets, so the transport's timers must run on the actual clock.
  const pause = Promise.withResolvers<void>();
  setTimeout(pause.resolve, 200);
  await pause.promise;

  expect(transport.isReady()).toBe(true);
  expect(server.hellos).toHaveLength(1);
  expect(logs.some((l) => l.includes("rejected: bad fleet"))).toBe(true);
});

it("sends periodic pings", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const transport = makeTransport({ pingIntervalMs: 30 });
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(server.frames.filter((f) => f.type === "ping").length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
  const pings = server.frames.filter((f) => f.type === "ping");
  expect(typeof pings[0]!.t).toBe("number");
});

it("terminates and reconnects when pings go unanswered", async () => {
  const server = await startFakeServer(60_000, { noPong: true }); // half-open peer
  teardown.push(server.close);
  const transport = makeTransport({ pingIntervalMs: 30 });
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  // No pongs → lastPongAt goes stale → terminate → reconnect handshake.
  await vi.waitFor(() => expect(server.hellos.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
});

it("does not reconnect after stop()", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const transport = makeTransport();
  transport.connect(server.url);

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  await transport.stop();
  server.kickAll(); // no live agent socket; nothing to terminate

  // Real delay is required here: we assert the absence of a reconnect over
  // live sockets, so the transport's timers must run on the actual clock.
  const pause = Promise.withResolvers<void>();
  setTimeout(pause.resolve, 200);
  await pause.promise;

  expect(server.hellos).toHaveLength(1);
  expect(transport.isReady()).toBe(false);
});

it("starts the LLM probe loop from config-update and sends schema-valid llm frames", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const detectOnlyFlags: boolean[] = [];
  const transport = makeTransport({
    collectLlm: async (detectOnly) => {
      detectOnlyFlags.push(detectOnly);
      return [fakeLlmPort(8080, 123.45)];
    },
  });
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  expect(llmFrames(server)).toHaveLength(0); // no probes configured yet

  server.broadcast({
    type: "config-update",
    cadenceMs: 60_000,
    llmPorts: [{ port: 8080, host: "127.0.0.1" }],
    llmCadenceMs: 25,
    llmDetectOnly: false,
  });

  await vi.waitFor(() => expect(llmFrames(server).length).toBeGreaterThanOrEqual(3), {
    timeout: 5000,
  });
  const frames = llmFrames(server).map((f) => llmMsgSchema.parse(f));
  expect(frames[0]).toMatchObject({
    type: "llm",
    schemaVersion: 1,
    agentVersion: "0.0.0-test",
  });
  expect(frames[0]!.ports).toHaveLength(1);
  expect(frames[0]!.ports[0]!.port).toBe(8080);
  expect(frames[0]!.ports[0]!.decodeTps).toBe(123.45);
  expect(detectOnlyFlags.every((f) => f === false)).toBe(true);
});

it("passes llmDetectOnly through and applies onLlmConfig overrides", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const detectOnlyFlags: boolean[] = [];
  const seenServerPorts: number[][] = [];
  const transport = makeTransport({
    collectLlm: async (detectOnly) => {
      detectOnlyFlags.push(detectOnly);
      return [fakeLlmPort(8080, 1)];
    },
    onLlmConfig: (config) => {
      seenServerPorts.push(config.llmPorts.map((p) => p.port));
      // Env override: probe 9999 too, force detection-only.
      return {
        llmPorts: [...config.llmPorts, { port: 9999, host: "127.0.0.1" }],
        llmCadenceMs: config.llmCadenceMs > 0 ? config.llmCadenceMs : 1000,
        llmDetectOnly: true,
      };
    },
  });
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  server.broadcast({
    type: "config-update",
    cadenceMs: 60_000,
    llmPorts: [{ port: 8080, host: "127.0.0.1" }],
    llmCadenceMs: 25,
    llmDetectOnly: false,
  });

  await vi.waitFor(() => expect(llmFrames(server).length).toBeGreaterThanOrEqual(1), {
    timeout: 5000,
  });
  expect(seenServerPorts).toEqual([[8080]]);
  // The effective config carries the merged port list and the override flag.
  expect(transport.getLlmConfig()).toEqual({
    llmPorts: [
      { port: 8080, host: "127.0.0.1" },
      { port: 9999, host: "127.0.0.1" },
    ],
    llmCadenceMs: 25,
    llmDetectOnly: true,
  });
  expect(detectOnlyFlags.every((f) => f === true)).toBe(true);
});

it("does not buffer llm frames while disconnected and drops them on send", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const transport = makeTransport({
    llm: { llmPorts: [{ port: 8080, host: "127.0.0.1" }], llmCadenceMs: 20, llmDetectOnly: false },
    collectLlm: async () => [fakeLlmPort(8080, 5)],
    // Slow enough that the disconnected window is observably long.
    reconnectBaseMs: 500,
  });
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  // Seeded llm config runs the loop even before hello-ok; frames only flow
  // while ready, and a send on a closed socket is dropped (never buffered).
  transport.sendLlm([fakeLlmPort(8080, 7)]);
  await vi.waitFor(() => expect(llmFrames(server).length).toBeGreaterThanOrEqual(1), { timeout: 10_000 });

  server.kickAll();
  await vi.waitFor(() => expect(transport.isReady()).toBe(false));
  transport.sendLlm([fakeLlmPort(8080, 8)]);

  await vi.waitFor(() => expect(server.hellos).toHaveLength(2), { timeout: 5000 });
  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  const ports = llmFrames(server).flatMap((f) => f.ports.map((p) => p.decodeTps));
  expect(ports).not.toContain(8); // point-in-time sample dropped while offline
});

it("applies the global HF token from config-update: set, clear, keep (IRI-019)", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const transport = makeTransport();
  transport.connect(server.url);
  await vi.waitFor(() => expect(transport.isReady()).toBe(true));

  // string = set
  server.broadcast({ type: "config-update", cadenceMs: 25_000, hfToken: "hf_x" });
  await vi.waitFor(() => expect(transport.getHfToken()).toBe("hf_x"));

  // old-server shape (key absent) keeps the current value
  server.broadcast({ type: "config-update", cadenceMs: 26_000 });
  await vi.waitFor(() => expect(transport.getCadenceMs()).toBe(26_000), { timeout: 10_000 });
  expect(transport.getHfToken()).toBe("hf_x");

  // null = clear (env fallback applies downstream)
  server.broadcast({ type: "config-update", cadenceMs: 27_000, hfToken: null });
  await vi.waitFor(() => expect(transport.getCadenceMs()).toBe(27_000), { timeout: 10_000 });
  expect(transport.getHfToken()).toBeNull();
});
