import type { Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  agentMsgSchema,
  isAgentSupported,
  type HardwareSnapshot,
} from "@irori/core";
import type { NodeStore } from "@irori/db";
import type { Rings } from "./rings.js";
import type { SseHub } from "./sse.js";

const MAX_PENDING_SNAPSHOTS = 1000;
const DEFAULT_SNAPSHOT_FLUSH_MS = 5_000;
const DEFAULT_MARK_SEEN_THROTTLE_MS = 30_000;

export interface AgentHubDeps {
  store: Pick<NodeStore, "verifyToken" | "markSeen" | "insertSnapshot">;
  rings: Rings;
  sse: Pick<SseHub, "send">;
  cadenceMs: number;
  serverVersion: string;
  /** Injectables for tests. */
  snapshotFlushMs?: number;
  markSeenThrottleMs?: number;
}

export interface AgentHub {
  /** Registers the /agent-ws upgrade handler on the given HTTP server. */
  attach(server: Server): void;
  /** Ids of nodes with a live, authenticated agent connection. */
  online(): ReadonlySet<string>;
  stop(): void;
}

/**
 * Agent WebSocket hub. First frame must be a hello; the token is verified via
 * the store, unsupported agent versions are refused, and snapshots fan out to
 * the rings + SSE while being persisted fire-and-forget. DB failures buffer
 * up to MAX_PENDING_SNAPSHOTS (drop-oldest) and flush while the DB is back.
 */
export function createAgentHub(deps: AgentHubDeps): AgentHub {
  const wss = new WebSocketServer({ noServer: true });
  const onlineNodes = new Set<string>();
  const lastMarkedAt = new Map<string, number>();
  const pending: Array<{ nodeId: string; payload: unknown }> = [];
  const throttleMs = deps.markSeenThrottleMs ?? DEFAULT_MARK_SEEN_THROTTLE_MS;

  let flushing = false;
  const flushTimer = setInterval(() => void flushPending(), deps.snapshotFlushMs ?? DEFAULT_SNAPSHOT_FLUSH_MS);
  flushTimer.unref();

  async function flushPending(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    try {
      while (pending.length > 0) {
        const next = pending[0]!;
        try {
          await deps.store.insertSnapshot(next.nodeId, next.payload);
          pending.shift();
        } catch {
          break; // DB still unhealthy; retry on the next tick
        }
      }
    } finally {
      flushing = false;
    }
  }

  function enqueuePending(nodeId: string, payload: unknown): void {
    pending.push({ nodeId, payload });
    while (pending.length > MAX_PENDING_SNAPSHOTS) pending.shift(); // drop oldest
  }

  wss.on("connection", (ws: WebSocket) => {
    let nodeId: string | null = null;
    let agentVersion: string | null = null;
    let chain: Promise<void> = Promise.resolve();

    const sendMsg = (msg: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const reject = (message: string): void => {
      sendMsg({ type: "error", message });
      ws.close();
    };
    const markSeen = async (id: string, version: string): Promise<void> => {
      const now = Date.now();
      if (now - (lastMarkedAt.get(id) ?? 0) < throttleMs) return;
      lastMarkedAt.set(id, now);
      try {
        await deps.store.markSeen(id, version);
      } catch {
        lastMarkedAt.delete(id); // allow a retry on the next event
      }
    };

    // Serialize frames per connection so hello auth always precedes snapshots.
    ws.on("message", (raw: RawData) => {
      chain = chain.then(() => handleMessage(raw)).catch(() => {});
    });

    async function handleMessage(raw: RawData): Promise<void> {
      let data: unknown;
      try {
        const text = Buffer.isBuffer(raw)
          ? raw.toString()
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString()
            : Buffer.from(new Uint8Array(raw)).toString();
        data = JSON.parse(text);
      } catch {
        // Unauthenticated garbage closes; later garbage is tolerated with an error frame.
        if (nodeId === null) return reject("invalid message frame");
        sendMsg({ type: "error", message: "invalid message frame" });
        return;
      }
      const parsed = agentMsgSchema.safeParse(data);
      if (!parsed.success) {
        if (nodeId === null) return reject("invalid message frame");
        sendMsg({ type: "error", message: "invalid message frame" });
        return;
      }
      const msg = parsed.data;

      const currentId = nodeId;
      if (currentId === null) {
        if (msg.type !== "hello") return reject("first frame must be hello");
        const id = await deps.store.verifyToken(msg.token);
        if (id === null) return reject("invalid agent token");
        if (!isAgentSupported(msg.agentVersion)) {
          return reject(`unsupported agent version: ${msg.agentVersion}`);
        }
        nodeId = id;
        agentVersion = msg.agentVersion;
        onlineNodes.add(id);
        deps.sse.send({ type: "node-online", serverTimeMs: Date.now(), nodeId: id, agentVersion });
        void markSeen(id, msg.agentVersion);
        sendMsg({ type: "hello-ok", nodeId: id, cadenceMs: deps.cadenceMs, serverVersion: deps.serverVersion });
        return;
      }

      if (msg.type === "snapshot") {
        const snapshot: HardwareSnapshot = msg.snapshot;
        deps.rings.push(currentId, snapshot);
        deps.sse.send({ type: "snapshot", serverTimeMs: Date.now(), nodeId: currentId, snapshot });
        void markSeen(currentId, agentVersion ?? "unknown");
        try {
          await deps.store.insertSnapshot(currentId, snapshot);
        } catch {
          enqueuePending(currentId, snapshot);
        }
        return;
      }

      if (msg.type === "ping") sendMsg({ type: "pong", t: msg.t });
      // A repeated hello on an authenticated connection is ignored.
    }

    ws.on("close", () => {
      if (nodeId === null) return;
      onlineNodes.delete(nodeId);
      lastMarkedAt.delete(nodeId);
      deps.sse.send({ type: "node-offline", serverTimeMs: Date.now(), nodeId, agentVersion });
    });
  });

  return {
    attach(server) {
      server.on("upgrade", (req, socket, head) => {
        const { pathname } = new URL(req.url ?? "/", "http://localhost");
        if (pathname !== "/agent-ws") {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      });
    },
    online: () => onlineNodes,
    stop() {
      clearInterval(flushTimer);
      for (const ws of wss.clients) ws.close(1001, "server shutting down");
    },
  };
}
