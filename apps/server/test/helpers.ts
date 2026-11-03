import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import {
  llmPortSnapshotSchema,
  SCHEMA_VERSION,
  serverMsgSchema,
  type HardwareSnapshot,
  type LlmPortSnapshot,
  type SseEvent,
  type ServerMsg,
} from "@irori/core";
import type { NodeCreateInput, NodePatchInput, NodeRecord, NodeStore } from "@irori/db";
import type { LlmStore } from "../src/llm-store.js";
import type { SseHub } from "../src/sse.js";

/** In-memory NodeStore + LlmStore fake shared by app and hub tests. */
export interface FakeStores {
  store: NodeStore;
  llmStore: LlmStore;
  rows: Map<string, NodeRecord>;
  tokens: Map<string, string>;
  snapshots: Array<{ nodeId: string; payload: unknown }>;
  llmSnapshots: Array<{ nodeId: string; payload: unknown }>;
  seen: Array<{ nodeId: string; agentVersion: string }>;
  setFailInserts(v: boolean): void;
  setFailLlmInserts(v: boolean): void;
}

export function makeFakeStore(): FakeStores {
  const rows = new Map<string, NodeRecord>();
  const tokens = new Map<string, string>();
  const snapshots: Array<{ nodeId: string; payload: unknown }> = [];
  const llmSnapshots: Array<{ nodeId: string; payload: unknown }> = [];
  const seen: Array<{ nodeId: string; agentVersion: string }> = [];
  let failInserts = false;
  let failLlmInserts = false;
  let tokenCounter = 0;
  const now = () => new Date();
  const nextToken = () => `token-${++tokenCounter}`;

  const store: NodeStore = {
    async list() {
      return [...rows.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async create(input: NodeCreateInput) {
      const id = randomUUID();
      const token = nextToken();
      const ts = now();
      rows.set(id, {
        id,
        name: input.name,
        kind: input.kind,
        role: input.role,
        host: input.host,
        enabled: input.enabled ?? true,
        agentVersion: null,
        lastSeenAt: null,
        sortOrder: 0,
        llmPorts: [],
        createdAt: ts,
        updatedAt: ts,
      });
      tokens.set(token, id);
      return { id, token };
    },
    async patch(id, patch: NodePatchInput) {
      const row = rows.get(id);
      if (row) Object.assign(row, patch, { updatedAt: now() });
    },
    async remove(id) {
      rows.delete(id);
      for (const [token, nodeId] of tokens) {
        if (nodeId === id) tokens.delete(token);
      }
    },
    async rotateToken(id) {
      const row = rows.get(id);
      if (!row) throw new Error("node not found");
      for (const [token, nodeId] of tokens) {
        if (nodeId === id) tokens.delete(token);
      }
      const token = nextToken();
      tokens.set(token, id);
      row.updatedAt = now();
      return { id, token };
    },
    async verifyToken(token) {
      const id = tokens.get(token);
      if (id === undefined) return null;
      return rows.get(id)?.enabled ? id : null;
    },
    async markSeen(nodeId, agentVersion) {
      const row = rows.get(nodeId);
      if (row) {
        row.agentVersion = agentVersion;
        row.lastSeenAt = now();
      }
      seen.push({ nodeId, agentVersion });
    },
    async setGpuClockCap(nodeId, capMHz, persistent) {
      const row = rows.get(nodeId);
      if (row !== undefined) {
        row.gpuClockCapMHz = capMHz;
        row.gpuClockCapPersistent = persistent;
      }
    },
    async insertSnapshot(nodeId, payload) {
      if (failInserts) throw new Error("db down");
      snapshots.push({ nodeId, payload });
    },
    async pruneSnapshots() {
      return 0;
    },
    async countSnapshots(nodeId) {
      return snapshots.filter((s) => s.nodeId === nodeId).length;
    },
  };

  const llmStore: LlmStore = {
    async insertLlmSnapshot(nodeId, payload) {
      if (failLlmInserts) throw new Error("db down");
      llmSnapshots.push({ nodeId, payload });
    },
    async pruneLlmSnapshots() {
      return 0;
    },
    async pruneLlmBuckets() {
      return 0;
    },
    async latestLlmSnapshot(nodeId) {
      for (let i = llmSnapshots.length - 1; i >= 0; i--) {
        const entry = llmSnapshots[i]!;
        if (entry.nodeId !== nodeId) continue;
        const payload: unknown = entry.payload;
        const ports =
          typeof payload === "object" && payload !== null && "ports" in payload ? payload.ports : undefined;
        return { serverTimeMs: now().getTime(), ports: Array.isArray(ports) ? ports : [] };
      }
      return null;
    },
    async setNodeLlmPorts(nodeId, ports) {
      const row = rows.get(nodeId);
      if (!row) throw new Error("node not found");
      row.llmPorts = ports.map((port) => ({ port, host: "127.0.0.1" }));
      row.updatedAt = now();
    },
  };

  return {
    store,
    llmStore,
    rows,
    tokens,
    snapshots,
    llmSnapshots,
    seen,
    setFailInserts: (v: boolean) => {
      failInserts = v;
    },
    setFailLlmInserts: (v: boolean) => {
      failLlmInserts = v;
    },
  };
}

let snapshotCounter = 0;
export function makeSnapshot(overrides: Partial<HardwareSnapshot> = {}): HardwareSnapshot {
  snapshotCounter++;
  return {
    schemaVersion: SCHEMA_VERSION,
    agentVersion: "0.1.0",
    hostname: "spark1",
    transport: "ws",
    timestampMs: Date.now() + snapshotCounter,
    cpu: { model: "GB10 SoC", cores: 20, usagePct: 12.5, tempC: null, packagePowerW: null },
    memory: { totalBytes: 128e9, usedBytes: 64e9, swapTotalBytes: null, swapUsedBytes: null },
    unifiedMemory: null,
    storage: [],
    network: [],
    memoryBandwidth: null,
    kernel: null,
    gpus: [
      {
        index: 0,
        name: "GB10",
        uuid: null,
        usagePct: 30,
        tempC: 55,
        memUsedBytes: 1e9,
        memTotalBytes: 120e9,
        powerW: 40,
        powerLimitW: null,
        smClockMHz: null,
        smClockMaxMHz: null,
        throttleReasons: [],
        processes: [],
      },
    ],
    ...overrides,
  };
}

export function makeSseSpy() {
  const events: SseEvent[] = [];
  return { events, sse: { send: (event: SseEvent) => { events.push(event); } } satisfies Pick<SseHub, "send"> };
}

export function opened(ws: WebSocket, ms = 2000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (ws.readyState === WebSocket.OPEN) {
    resolve();
    return promise;
  }
  const timer = setTimeout(() => reject(new Error("timeout waiting for open")), ms);
  ws.once("open", () => {
    clearTimeout(timer);
    resolve();
  });
  return promise;
}

/**
 * Per-socket frame queue. hello-ok and config-update are sent back-to-back
 * and can land in one TCP segment; naive `ws.once("message")` chains either
 * double-fire one frame (two listeners) or drop the other (no listener).
 * One persistent listener feeds a FIFO instead.
 */
const frameStates = new WeakMap<
  WebSocket,
  { queue: ServerMsg[]; waiters: Array<{ resolve: (m: ServerMsg) => void; reject: (e: Error) => void }> }
>();

function frameStateFor(ws: WebSocket) {
  let st = frameStates.get(ws);
  if (!st) {
    st = { queue: [], waiters: [] };
    frameStates.set(ws, st);
    ws.on("message", (data: unknown) => {
      const parsed = serverMsgSchema.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      const waiter = st.waiters.shift();
      if (waiter) waiter.resolve(parsed.data);
      else st.queue.push(parsed.data);
    });
  }
  return st;
}

export function nextMessage(ws: WebSocket, ms = 2000): Promise<ServerMsg> {
  const st = frameStateFor(ws);
  const queued = st.queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  const waiter = Promise.withResolvers<ServerMsg>();
  const entry = { resolve: waiter.resolve, reject: waiter.reject };
  st.waiters.push(entry);
  const timer = setTimeout(() => {
    const i = st.waiters.indexOf(entry);
    if (i >= 0) st.waiters.splice(i, 1);
    waiter.reject(new Error("timeout waiting for frame"));
  }, ms);
  return waiter.promise.finally(() => clearTimeout(timer));
}

export function nextClose(ws: WebSocket, ms = 2000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => reject(new Error("timeout waiting for close")), ms);
  ws.once("close", () => {
    clearTimeout(timer);
    resolve();
  });
  return promise;
}

export async function listen(server: Server): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, resolve);
  await promise;
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("server has no port");
  return addr.port;
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

let llmPortCounter = 0;
/** One valid LlmPortSnapshot with distinct, deterministic metrics per call. */
export function makeLlmPort(overrides: Partial<LlmPortSnapshot> = {}): LlmPortSnapshot {
  llmPortCounter++;
  return llmPortSnapshotSchema.parse({
    port: 8000 + (llmPortCounter % 100),
    backend: "exl3",
    detected: true,
    model: "glm-4.6",
    decodeTps: 40 + llmPortCounter,
    prefillTps: 900 + llmPortCounter,
    queueRunning: 1,
    queueWaiting: 2,
    kvCachePct: 12.5,
    ttftP95Ms: 210 + llmPortCounter,
    e2eP95Ms: 900,
    itlP95Ms: 30,
    engineMeta: null,
    probedAtMs: 1_000_000 + llmPortCounter,
    ...overrides,
  });
}

/** Agent → server llm frame with the given ports (default: one). */
export function makeLlmMsg(ports: LlmPortSnapshot[] = [makeLlmPort()]): string {
  return JSON.stringify({ type: "llm", schemaVersion: SCHEMA_VERSION, agentVersion: "0.1.0", ports });
}
