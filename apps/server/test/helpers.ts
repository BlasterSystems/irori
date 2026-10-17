import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket } from "ws";
import { serverMsgSchema, SCHEMA_VERSION, type HardwareSnapshot, type SseEvent, type ServerMsg } from "@irori/core";
import type { NodeCreateInput, NodePatchInput, NodeRecord, NodeStore } from "@irori/db";
import type { SseHub } from "../src/sse.js";

/** In-memory NodeStore fake shared by app and hub tests. */
export function makeFakeStore() {
  const rows = new Map<string, NodeRecord>();
  const tokens = new Map<string, string>();
  const snapshots: Array<{ nodeId: string; payload: unknown }> = [];
  const seen: Array<{ nodeId: string; agentVersion: string }> = [];
  let failInserts = false;
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

  return { store, rows, tokens, snapshots, seen, setFailInserts: (v: boolean) => { failInserts = v; } };
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

export function nextMessage(ws: WebSocket, ms = 2000): Promise<ServerMsg> {
  const { promise, resolve, reject } = Promise.withResolvers<ServerMsg>();
  const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
  ws.once("message", (data: unknown) => {
    clearTimeout(timer);
    resolve(serverMsgSchema.parse(JSON.parse(String(data))));
  });
  return promise;
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
