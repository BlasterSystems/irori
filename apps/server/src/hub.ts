import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  agentMsgSchema,
  agentServerMsgSchema,
  isAgentSupported,
  MAX_USAGE_FRAME_BYTES,
  type AgentServerMsg,
  type BenchDoneMsg,
  type BenchProgressMsg,
  type GpuSnapshot,
  type HardwareSnapshot,
  type LogEvent,
  type SetupAckMsg,
  type SetupEventMsg,
  type SetupLogMsg,
  type SetupValidateResultMsg,
  type ClocksGetResultMsg,
  type ClocksSetResultMsg,
  type NodeShutdownAckMsg,
  type TransferProgress,
  type UsageRequest,
} from "@irori/core";
import { randomUUID } from "node:crypto";
import type { NodeStore } from "@irori/db";
import type { LlmStore } from "./llm-store.js";
import { nodeLlmAssignments } from "./llm-store.js";
import type { LlmRingEntry, Rings } from "./rings.js";
import type { SseHub } from "./sse.js";
import { log } from "./logger.js";

/** Drop-oldest cap for buffered DB writes (snapshots, llm probe passes, terminal job/bench frames). */
const MAX_PENDING_WRITES = 1000;

/**
 * GPU throttle-reason set changes between consecutive snapshots (IRI-013).
 * Compared as sorted sets (nvidia-smi ordering is not guaranteed); a card
 * seen for the first time produces no transition. Active reasons are
 * returned sorted so feed lines are deterministic.
 */
export function thermalTransitions(prev: GpuSnapshot[], next: GpuSnapshot[]): Array<{ gpuIndex: number; active: string[] }> {
  const out: Array<{ gpuIndex: number; active: string[] }> = [];
  for (const g of next) {
    const was = prev.find((p) => p.index === g.index);
    if (was === undefined) continue;
    const active = [...g.throttleReasons].sort();
    if (was.throttleReasons === undefined) continue;
    if ([...was.throttleReasons].sort().join("\u0000") === active.join("\u0000")) continue;
    out.push({ gpuIndex: g.index, active });
  }
  return out;
}
const DEFAULT_WRITE_FLUSH_MS = 5_000;
const DEFAULT_MARK_SEEN_THROTTLE_MS = 30_000;
/** Probe cadence handed to agents: heads/standalone probe, workers detect-only. */
const LLM_PROBE_CADENCE_MS = 2_000;
const LLM_DETECT_CADENCE_MS = 10_000;

export interface AgentHubDeps {
  store: Pick<NodeStore, "get" | "verifyToken" | "markSeen" | "insertSnapshot">;
  llmStore: Pick<LlmStore, "insertLlmSnapshot">;
  rings: Rings;
  sse: Pick<SseHub, "send">;
  /** Resolved per hello/config-update so a settings change applies without restart. */
  getCadenceMs: () => number;
  serverVersion: string;
  /** Agent frame routing for the jobs subsystem + catalog cache (M4). */
  jobEvents: {
    onOutput: (nodeId: string, jobId: string, seq: number, line: string) => Promise<TransferProgress | null>;
    onDone: (nodeId: string, jobId: string, status: "succeeded" | "failed" | "canceled", exitCode: number | null) => Promise<void>;
    /** IR-131: the agent confirmed the process-group kill. */
    onCancelAck: (nodeId: string, jobId: string) => Promise<void>;
    onCatalog: (nodeId: string, source: "catalog" | "scan", entries: Array<{ name: string; runtime: string; repository: string; bytes: number }>) => Promise<void>;
    /** IRI-012: fires on every authenticated hello — settles agent-update jobs. */
    onHello?: (nodeId: string, agentVersion: string) => Promise<unknown>;
    /** IR-131: settles running rows the freshly-connected agent no longer runs. */
    onOrphans?: (nodeId: string, activeJobs: Array<{ jobId: string }> | undefined) => Promise<unknown>;
  };
  /** Setup supervision frames (M5): acks, driver events, log lines. All are
   *  verified against the sending node so a rogue agent cannot forge frames
   *  for another node's setups. */
  setupEvents: {
    onAck(msg: SetupAckMsg, senderNodeId: string): Promise<void>;
    onEvent(msg: SetupEventMsg, senderNodeId: string): Promise<void>;
    onLog(msg: SetupLogMsg, senderNodeId: string): Promise<void>;
    onValidateResult(msg: SetupValidateResultMsg, senderNodeId: string): void;
  };
  /** Bench frames (M6): throttled progress + terminal results. */
  benchEvents: {
    onProgress(nodeId: string, runId: string, progress: BenchProgressMsg["progress"]): void;
    onDone(nodeId: string, runId: string, status: "completed" | "failed" | "canceled", result: unknown, error: string | null): Promise<void>;
  };
  /** Usage batches (M8): durable insert; false when the DB is unavailable (no ack). */
  usageEvents: {
    onBatch(nodeId: string, events: UsageRequest[]): Promise<boolean>;
  };
  /** Durable log batches (IRI-078): insert + drop-counter fold; returns the
   *  store outcome so the hub acks ids and pulses the Logs view. */
  logEvents?: {
    onBatch(nodeId: string, events: LogEvent[], dropped: number): Promise<{ inserted: number; latestId: string | null } | null>;
  };
  /**
   * IRI-019: global HF token read for config-update frames. string = set,
   * null = clear, undefined = unknown (read failure — the key is omitted so
   * the agent keeps its current token). Optional: hub tests may omit it.
   */
  getHfToken?: () => Promise<string | null | undefined>;
  /** IR-105: hub-pinned modelctl version; null = unset (agents keep env), absent = getter unavailable. */
  getModelctlPin?: () => Promise<string | null>;
  /** Injectables for tests. */
  writeFlushMs?: number;
  markSeenThrottleMs?: number;
}

export interface AgentHub {
  /** Registers the /agent-ws upgrade handler on the given HTTP server. */
  attach(server: Server): void;
  /** Ids of nodes with a live, authenticated agent connection. */
  online(): ReadonlySet<string>;
  /** Sends a raw frame to a connected node's agent; false when offline. */
  sendToNode(nodeId: string, msg: unknown): boolean;
  /** Resends the node's config-update (probe ports, cadence, nasRoot, HF token) live. */
  refreshConfig(nodeId: string): Promise<boolean>;
  /** IRI-067: per-GPU clocks + cap state; null = agent offline or no reply (8 s). */
  clocks(nodeId: string): Promise<ClocksGetResultMsg | null>;
  /** IRI-067: apply (or null = reset) the SM application clock cap. */
  setClocks(nodeId: string, smMaxMHz: number | null, persist?: boolean): Promise<ClocksSetResultMsg | null>;
  /** IRI-068: armed node shutdown; the agent acks, then powers off after graceS. */
  shutdownNode(nodeId: string, graceS: number, origin: string): Promise<NodeShutdownAckMsg | null>;
  stop(): void;
}

/**
 * Agent WebSocket hub. First frame must be a hello; the token is verified via
 * the store, unsupported agent versions are refused, and snapshots/llm probe
 * passes fan out to the rings + SSE while being persisted fire-and-forget.
 * DB failures buffer up to MAX_PENDING_WRITES (drop-oldest) and flush while
 * the DB is back. Every hello-ok is followed by a config-update carrying the
 * node's probe assignments and role-derived llm cadence.
 */
export function createAgentHub(deps: AgentHubDeps): AgentHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_USAGE_FRAME_BYTES });
  const onlineNodes = new Set<string>();
  const nodeSockets = new Map<string, WebSocket>();
  const lastMarkedAt = new Map<string, number>();
  const pending: Array<{ nodeId: string; kind: "snapshot" | "llm" | "job-done" | "bench-done"; payload: unknown }> = [];
  const throttleMs = deps.markSeenThrottleMs ?? DEFAULT_MARK_SEEN_THROTTLE_MS;

  /** Builds and sends the node's config-update (probe ports, cadence, nasRoot, HF token). */
  const sendConfigUpdate = async (id: string, sendMsg: (msg: unknown) => void): Promise<void> => {
    const row = await deps.store.get(id);
    const msg: Record<string, unknown> = {
      type: "config-update",
      cadenceMs: deps.getCadenceMs(),
      llmPorts: nodeLlmAssignments(row),
      llmCadenceMs: row?.role === "worker" ? LLM_DETECT_CADENCE_MS : LLM_PROBE_CADENCE_MS,
      llmDetectOnly: row?.role === "worker",
      nasRoot: row?.nasRoot ?? null,
      // IR-101: cache owner for transfers; null = the agent's own user.
      cacheUser: row?.cacheUser ?? null,
    };
    // IRI-019: global HF token — set / clear / omit on read failure (the
    // agent keeps its current value when the key is absent).
    const hfToken = deps.getHfToken === undefined ? undefined : await deps.getHfToken().catch(() => undefined);
    if (hfToken !== undefined) msg.hfToken = hfToken;
    // IR-105: hub-pinned modelctl version — absent on a read failure (the
    // agent keeps its current value); null = unset, so the agent's env pin
    // applies again.
    const modelctlPin = deps.getModelctlPin === undefined ? undefined : await deps.getModelctlPin().catch(() => undefined);
    if (modelctlPin !== undefined) msg.modelctlPin = modelctlPin;
    sendMsg(msg);
  };

  let flushing = false;
  const flushTimer = setInterval(() => void flushPending(), deps.writeFlushMs ?? DEFAULT_WRITE_FLUSH_MS);
  flushTimer.unref();

  async function flushPending(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    try {
      while (pending.length > 0) {
        const next = pending[0]!;
        try {
          if (next.kind === "snapshot") await deps.store.insertSnapshot(next.nodeId, next.payload);
          else if (next.kind === "llm") await deps.llmStore.insertLlmSnapshot(next.nodeId, next.payload);
          else if (next.kind === "job-done") {
            const p = next.payload as { jobId: string; status: "succeeded" | "failed" | "canceled"; exitCode: number | null };
            await deps.jobEvents.onDone(next.nodeId, p.jobId, p.status, p.exitCode);
          } else {
            const p = next.payload as { runId: string; status: "completed" | "failed" | "canceled"; result: unknown; error: string | null };
            await deps.benchEvents.onDone(next.nodeId, p.runId, p.status, p.result, p.error);
          }
          pending.shift();
        } catch {
          break; // DB still unhealthy; retry on the next tick
        }
      }
    } finally {
      flushing = false;
    }
  }

  function enqueuePending(nodeId: string, kind: "snapshot" | "llm" | "job-done" | "bench-done", payload: unknown): void {
    pending.push({ nodeId, kind, payload });
    while (pending.length > MAX_PENDING_WRITES) pending.shift(); // drop oldest
  }

  // IRI-067/068: clocks + shutdown request/response — keyed `${nodeId}:${requestId}` (uuids
  // cannot collide, so a hub-wide map is safe across reconnects).
  const clocksPending = new Map<string, { resolve: (frame: ClocksGetResultMsg | ClocksSetResultMsg | NodeShutdownAckMsg) => void; timer: NodeJS.Timeout }>();

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let nodeId: string | null = null;
    let agentVersion: string | null = null;
    let chain: Promise<void> = Promise.resolve();

    const sendMsg = (msg: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const reject = (message: string): void => {
      log.warn(`rejected agent from ${req.socket.remoteAddress ?? "unknown"}: ${message}`);
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
        // Job/catalog frames are AgentServerMsg, not AgentMsg — the second
        // handler owns them; never send an error frame for those.
        if (agentServerMsgSchema.safeParse(data).success) return;
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
        nodeSockets.set(id, ws);
        // IRI-012: settle any in-flight agent-update from the fresh version.
        // markSeen is throttled, so this hook is the only unthrottled spot.
        if (deps.jobEvents?.onHello) void deps.jobEvents.onHello(id, msg.agentVersion).catch(() => {});
        // IR-131: rows the fresh agent no longer runs are dead processes.
        if (deps.jobEvents?.onOrphans) void deps.jobEvents.onOrphans(id, msg.activeJobs).catch(() => {});
        deps.sse.send({ type: "node-online", serverTimeMs: Date.now(), nodeId: id, agentVersion });
        // Hello is once per connection: record the version immediately (the
        // update gate and drift views read it). Snapshots stay throttled.
        lastMarkedAt.set(id, Date.now());
        deps.store.markSeen(id, msg.agentVersion).catch(() => lastMarkedAt.delete(id));
        sendMsg({ type: "hello-ok", nodeId: id, cadenceMs: deps.getCadenceMs(), serverVersion: deps.serverVersion });
        // Probe assignments + role-derived cadence. A worker's role may change
        // without a reconnect only via a later config-update; hello covers boot.
        await sendConfigUpdate(id, sendMsg);
        return;
      }

      if (msg.type === "snapshot") {
        const snapshot: HardwareSnapshot = msg.snapshot;
        const prev = deps.rings.latest(currentId);
        deps.rings.push(currentId, snapshot);
        deps.sse.send({ type: "snapshot", serverTimeMs: Date.now(), nodeId: currentId, snapshot });
        // IRI-013: GPU throttle-reason set changes become feed events
        // (e.g. "HW Slowdown" appearing, then clearing) without any new
        // agent surface — computed from consecutive snapshots.
        for (const t of thermalTransitions(prev?.gpus ?? [], snapshot.gpus)) {
          deps.sse.send({ type: "thermal", serverTimeMs: Date.now(), nodeId: currentId, gpuIndex: t.gpuIndex, active: t.active });
        }
        void markSeen(currentId, agentVersion ?? "unknown");
        try {
          await deps.store.insertSnapshot(currentId, snapshot);
        } catch {
          enqueuePending(currentId, "snapshot", snapshot);
        }
        return;
      }

      if (msg.type === "llm") {
        const entry: LlmRingEntry = { serverTimeMs: Date.now(), ports: msg.ports };
        deps.rings.pushLlm(currentId, entry);
        deps.sse.send({ type: "llm", serverTimeMs: entry.serverTimeMs, nodeId: currentId, ports: msg.ports });
        const payload = { schemaVersion: msg.schemaVersion, agentVersion: msg.agentVersion, ports: msg.ports };
        try {
          await deps.llmStore.insertLlmSnapshot(currentId, payload);
        } catch {
          enqueuePending(currentId, "llm", payload);
        }
        return;
      }

      if (msg.type === "ping") sendMsg({ type: "pong", t: msg.t });
      // A repeated hello on an authenticated connection is ignored.
    }

    // Agent→server frames (jobs + catalog) ride the same socket; route them
    // through the deps so persistence stays outside the hub. Setup frames are
    // processed through a per-socket chain so ordering (stopping → stopped →
    // ack) is preserved despite the async DB work.
    let setupChain = Promise.resolve();
    let usageChain = Promise.resolve();
    // IRI-078: log batches serialize per connection so acks reach the agent
    // in send order (same contract as usage).
    let logChain = Promise.resolve();
    // IR-106: job output and terminal frames ride their own chain — the
    // settle reads the output row it just wrote (models-inventory report),
    // so back-to-back frames must not race the insert.
    let jobChain = Promise.resolve();
    ws.on("message", (raw: RawData) => {
      if (nodeId === null) return;
      const text = Buffer.isBuffer(raw)
        ? raw.toString()
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString()
          : Buffer.from(new Uint8Array(raw)).toString();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }
      const parsed = agentServerMsgSchema.safeParse(data);
      if (!parsed.success) {
        // snapshot/llm/ping/hello belong to the first handler — not an error here.
        if (agentMsgSchema.safeParse(data).success) return;
        log.error(`agentServerFrame parse failed: ${text.slice(0, 120)}`);
        return;
      }
      log.error(`agentServerFrame ${parsed.data.type} from ${nodeId}`);
      const currentId: string = nodeId;
      const frame = parsed.data;
      if (frame.type === "clocks-get-result" || frame.type === "clocks-set-result" || frame.type === "node-shutdown-ack") {
        // IRI-067: resolve the matching pending request; a reply after the
        // caller timed out is dropped (the map entry is already gone).
        const key = `${currentId}:${frame.id}`;
        const pending = clocksPending.get(key);
        if (pending !== undefined) {
          clocksPending.delete(key);
          clearTimeout(pending.timer);
          pending.resolve(frame);
        }
      } else if (frame.type === "job-output" || frame.type === "job-done" || frame.type === "job-cancel-ack") {
        jobChain = jobChain.then(async () => {
          try {
            if (frame.type === "job-output") await deps.jobEvents.onOutput(currentId, frame.jobId, frame.seq, frame.line);
            else if (frame.type === "job-cancel-ack") await deps.jobEvents.onCancelAck(currentId, frame.jobId);
            else await deps.jobEvents.onDone(currentId, frame.jobId, frame.status, frame.exitCode);
          } catch {
            // Terminal: a transient DB failure must not strand the one-active slot.
            if (frame.type === "job-done") {
              enqueuePending(currentId, "job-done", { jobId: frame.jobId, status: frame.status, exitCode: frame.exitCode });
            }
          }
        });
      } else if (frame.type === "catalog") {
        void deps.jobEvents.onCatalog(currentId, frame.source, frame.entries).catch(() => {});
      } else if (frame.type === "bench-progress") {
        deps.benchEvents.onProgress(currentId, frame.runId, frame.progress);
      } else if (frame.type === "bench-done") {
        void deps.benchEvents
          .onDone(currentId, frame.runId, frame.status, frame.result ?? null, frame.error)
          .catch(() =>
            enqueuePending(currentId, "bench-done", { runId: frame.runId, status: frame.status, result: frame.result ?? null, error: frame.error }),
          );
      } else if (frame.type === "setup-ack" || frame.type === "setup-event" || frame.type === "setup-log" || frame.type === "setup-validate-result") {
        setupChain = setupChain.then(() => routeSetupFrame(frame, currentId)).catch(() => {});
      } else if (frame.type === "usage-batch") {
        // Serialized per connection so acks reach the agent in send order.
        const events = frame.events;
        usageChain = usageChain
          .then(async () => {
            const ok = await deps.usageEvents.onBatch(currentId, events);
            if (!ok) return;
            // Live view + feed: one frame per captured request, post-insert.
            // IR-52: body bytes stay server-side — the browser gets metadata.
            const serverTimeMs = Date.now();
            for (const request of events) {
              const live = request.parts.length
                ? { ...request, parts: request.parts.map(({ gz: _gz, ...meta }) => meta) }
                : request;
              deps.sse.send({ type: "usage", serverTimeMs, nodeId: currentId, request: live });
            }
            sendMsg({ type: "usage-batch-ack", ids: events.map((e) => e.id) });
          })
          .catch(() => {});
      } else if (frame.type === "log-batch") {
        // IRI-078: durable log ingest. Serialized like usage so acks arrive in
        // send order. A null result (DB down) sends NO ack — the agent's
        // buffer keeps the rows and redelivers (the store dedupes on eventId).
        const events = frame.events;
        const dropped = frame.dropped;
        logChain = logChain
          .then(async () => {
            if (deps.logEvents === undefined) {
              // No store wired (degraded hub): ack nothing, drop the frame —
              // the agent's bounded buffer keeps trying until the DB is back.
              return;
            }
            const result = await deps.logEvents.onBatch(currentId, events, dropped);
            if (result === null) return;
            sendMsg({ type: "log-batch-ack", ids: events.map((e) => e.eventId) });
            // Wake-up for the Logs view (the rows themselves are REST). Only
            // when something actually stored — a pure-redelivery batch that
            // inserted nothing needs no pulse.
            if (result.inserted > 0) {
              deps.sse.send({
                type: "log-update",
                serverTimeMs: Date.now(),
                nodeId: currentId,
                count: result.inserted,
                latestId: result.latestId,
              });
            }
          })
          .catch(() => {});
      }
    });

    const routeSetupFrame = (frame: Extract<AgentServerMsg, { type: `setup-${string}` }>, senderNodeId: string): Promise<void> => {
      if (frame.type === "setup-ack") {
        deps.setupEvents.onAck(frame, senderNodeId);
        return Promise.resolve();
      }
      if (frame.type === "setup-event") return deps.setupEvents.onEvent(frame, senderNodeId);
      if (frame.type === "setup-log") return deps.setupEvents.onLog(frame, senderNodeId);
      deps.setupEvents.onValidateResult(frame, senderNodeId);
      return Promise.resolve();
    };

    ws.on("close", () => {
      if (nodeId === null) return;
      // A reconnecting agent's new hello already owns the registration; a
      // half-open old socket firing close late must not deregister it.
      if (nodeSockets.get(nodeId) !== ws) return;
      onlineNodes.delete(nodeId);
      nodeSockets.delete(nodeId);
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
    sendToNode(nodeId, msg) {
      const ws = nodeSockets.get(nodeId);
      if (ws === undefined || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    async refreshConfig(nodeId) {
      const ws = nodeSockets.get(nodeId);
      if (ws === undefined || ws.readyState !== WebSocket.OPEN) return false;
      await sendConfigUpdate(nodeId, (msg) => ws.send(JSON.stringify(msg)));
      return true;
    },
    async clocks(nodeId) {
      // IRI-067: request/response over the agent socket; null = offline or
      // no reply within 8 s (nvidia-smi timeouts are bounded at 3 s).
      const id = randomUUID();
      const ws = nodeSockets.get(nodeId);
      if (ws === undefined || ws.readyState !== WebSocket.OPEN) return null;
      const reply = await new Promise<ClocksGetResultMsg | null>((resolve) => {
        const timer = setTimeout(() => {
          clocksPending.delete(`${nodeId}:${id}`);
          resolve(null);
        }, 8000);
        clocksPending.set(`${nodeId}:${id}`, { resolve: (f) => resolve(f as ClocksGetResultMsg), timer });
        ws.send(JSON.stringify({ type: "clocks-get", id }));
      });
      return reply;
    },
    async setClocks(nodeId, smMaxMHz, persist = false) {
      const id = randomUUID();
      const ws = nodeSockets.get(nodeId);
      if (ws === undefined || ws.readyState !== WebSocket.OPEN) return null;
      const reply = await new Promise<ClocksSetResultMsg | null>((resolve) => {
        const timer = setTimeout(() => {
          clocksPending.delete(`${nodeId}:${id}`);
          resolve(null);
        }, 8000);
        clocksPending.set(`${nodeId}:${id}`, { resolve: (f) => resolve(f as ClocksSetResultMsg), timer });
        ws.send(JSON.stringify({ type: "clocks-set", id, smMaxMHz, ...(persist ? { persist: true } : {}) }));
      });
      return reply;
    },
    async shutdownNode(nodeId, graceS, origin) {
      // IRI-068: fire-and-ack — the agent acks BEFORE the grace poweroff.
      const id = randomUUID();
      const ws = nodeSockets.get(nodeId);
      if (ws === undefined || ws.readyState !== WebSocket.OPEN) return null;
      const reply = await new Promise<NodeShutdownAckMsg | null>((resolve) => {
        const timer = setTimeout(() => {
          clocksPending.delete(`${nodeId}:${id}`);
          resolve(null);
        }, 8000);
        clocksPending.set(`${nodeId}:${id}`, { resolve: (f) => resolve(f as NodeShutdownAckMsg), timer });
        ws.send(JSON.stringify({ type: "node-shutdown", id, graceS, origin }));
      });
      return reply;
    },
    stop() {
      clearInterval(flushTimer);
      for (const ws of wss.clients) ws.close(1001, "server shutting down");
    },
  };
}
