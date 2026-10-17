import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { agentMsgSchema, snapshotMsgSchema } from "@irori/core";
import type { AgentMsg, HardwareSnapshot, HelloMsg, SnapshotMsg } from "@irori/core";
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
async function startFakeServer(helloCadenceMs: number): Promise<FakeServer> {
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

let teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  const fns = teardown.reverse();
  teardown = [];
  for (const fn of fns) await fn();
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

it("closes and reconnects after a server error frame", async () => {
  const server = await startFakeServer(60_000);
  teardown.push(server.close);
  const logs: string[] = [];
  const transport = makeTransport({ log: (m) => logs.push(m) });
  transport.connect(server.url);
  teardown.push(() => transport.stop());

  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
  server.broadcast({ type: "error", message: "rejected: bad fleet" });

  await vi.waitFor(() => expect(server.hellos).toHaveLength(2), { timeout: 5000 });
  await vi.waitFor(() => expect(transport.isReady()).toBe(true));
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
