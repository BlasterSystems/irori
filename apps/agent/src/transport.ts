import { WebSocket } from "ws";
import { serverMsgSchema } from "@irori/core";
import type { AgentMsg, AgentServerMsg, BenchType, BodyRetention, HardwareSnapshot, LlmEvent, LlmPortSnapshot, LogEvent, ServerMsg, UsageRequest } from "@irori/core";

/** Bound on snapshots queued while the connection is down (drop-oldest). */
export const MAX_BUFFERED_SNAPSHOTS = 500;

/** Bound on terminal job/bench frames queued while offline (drop-oldest);
 *  losing one strands the server's one-active slot, so these are replayed. */
export const MAX_BUFFERED_TERMINAL = 100;

const DEFAULT_PING_INTERVAL_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Per-port LLM probe assignment. */
export interface LlmPortConfig {
  port: number;
  host: string;
}

/** Effective LLM probe runtime config (ports + cadence + detection-only flag). */
export interface LlmRuntimeConfig {
  llmPorts: LlmPortConfig[];
  /** 0 = LLM probes disabled. */
  llmCadenceMs: number;
  llmDetectOnly: boolean;
}

export interface AgentTransportOptions {
  /** Shared node token sent in the hello frame. */
  token: string;
  hostname: string;
  agentVersion: string;
  /** Wire/schema version sent in the hello frame. */
  schemaVersion: number;
  /** Initial snapshot cadence; the server overrides via hello-ok/config-update. */
  cadenceMs: number;
  /** Snapshot source; injectable for tests. */
  collect: () => Promise<HardwareSnapshot>;
  /** LLM probe source: one snapshot per assigned port, in a stable order. */
  collectLlm?: (detectOnly: boolean) => Promise<LlmPortSnapshot[]>;
  /**
   * Called when a config-update carries LLM probe config. Return the effective
   * config to apply (e.g. after merging env overrides); void applies the
   * server values as-is.
   */
  onLlmConfig?: (config: LlmRuntimeConfig) => LlmRuntimeConfig | void;
  /** LLM probe config seeded before the first config-update (env). */
  llm?: LlmRuntimeConfig;
  /** Server asks the agent to run one job (one active per node). */
  onJobRequest?: (jobId: string, kind: string, params: Record<string, unknown>) => void;
  onJobCancel?: (jobId: string) => void;
  /** Server asks the agent to read + report the NAS store catalog. */
  onCatalogRequest?: () => void;
  /** Server asks the agent to run one benchmark (one active per node, M6). */
  onBenchRun?: (runId: string, bench: BenchType, config: Record<string, unknown>) => void;
  onBenchCancel?: (runId: string) => void;
  /** Setup supervision (M5): start/stop resolve to an ack; status/attach are fire-and-forget. */
  onSetupStart?: (
    setupId: string,
    runId: string,
    scriptStart: string,
    scriptStop: string,
    env: Record<string, string>,
    modelPathName: string | null,
    capture: { proxyPort: number; retention: BodyRetention | null } | null,
  ) => Promise<{ ok: boolean; error: string | null }>;
  onSetupStop?: (setupId: string, gracefulMs: number) => Promise<{ ok: boolean; error: string | null }>;
  onSetupStatus?: (setupId: string) => void;
  onSetupLogAttach?: (setupId: string, lastSeq: number) => void;
  onSetupValidate?: (validateId: string, scripts: string[]) => void;
  onClocksGet?: (id: string) => void;
  onClocksSet?: (id: string, smMaxMHz: number | null) => void;
  /** Server acked a durable usage-batch insert (ids safe to delete locally). */
  onUsageAck?: (ids: string[]) => void;
  /** IRI-078: server acked a durable log-batch insert (ids safe to delete). */
  onLogAck?: (ids: string[]) => void;
  /** Called after hello-ok on every (re)connection — replay triggers. */
  onReconnect?: () => void;
  /** IR-131: job ids this agent process is running, reported in every hello. */
  getActiveJobIds?: () => Array<{ jobId: string; kind: string }>;
  maxBufferedSnapshots?: number;
  pingIntervalMs?: number;
  /** Base reconnect delay before jitter; doubles per failed attempt up to 30 s. */
  reconnectBaseMs?: number;
  log?: (message: string) => void;
}

/**
 * Owns the agent's single outbound WebSocket connection: hello handshake,
 * cadence-driven snapshots, pings, bounded offline buffering and reconnects.
 */
export class AgentTransport {
  private readonly token: string;
  private readonly hostname: string;
  private readonly agentVersion: string;
  private readonly schemaVersion: number;
  private readonly collect: () => Promise<HardwareSnapshot>;
  private readonly collectLlm?: (detectOnly: boolean) => Promise<LlmPortSnapshot[]>;
  private readonly onLlmConfig?: (config: LlmRuntimeConfig) => LlmRuntimeConfig | void;
  private readonly onJobRequest?: (jobId: string, kind: string, params: Record<string, unknown>) => void;
  private readonly onJobCancel?: (jobId: string) => void;
  private readonly onCatalogRequest?: () => void;
  private readonly onBenchRun?: (runId: string, bench: BenchType, config: Record<string, unknown>) => void;
  private readonly onBenchCancel?: (runId: string) => void;
  private readonly onSetupStart?: (
    setupId: string,
    runId: string,
    scriptStart: string,
    scriptStop: string,
    env: Record<string, string>,
    modelPathName: string | null,
    capture: { proxyPort: number; retention: BodyRetention | null } | null,
  ) => Promise<{ ok: boolean; error: string | null }>;
  private readonly onSetupStop?: (setupId: string, gracefulMs: number) => Promise<{ ok: boolean; error: string | null }>;
  private readonly onSetupStatus?: (setupId: string) => void;
  private readonly onSetupLogAttach?: (setupId: string, lastSeq: number) => void;
  private readonly onSetupValidate?: (validateId: string, scripts: string[]) => void;
  private readonly onClocksGet?: (id: string) => void;
  private readonly onClocksSet?: (id: string, smMaxMHz: number | null) => void;
  private readonly onUsageAck?: (ids: string[]) => void;
  private readonly onLogAck?: (ids: string[]) => void;
  private readonly onReconnect?: () => void;
  private readonly getActiveJobIds?: () => Array<{ jobId: string; kind: string }>;
  private readonly maxBufferedSnapshots: number;
  private readonly pingIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly log: (message: string) => void;

  private serverUrl: string | null = null;
  private ws: WebSocket | null = null;
  private nodeId: string | null = null;
  private cadenceMs: number;
  /** True once hello-ok was received on the current connection. */
  private ready = false;
  private stopped = false;
  private reconnectAttempts = 0;
  private collecting = false;
  /** Last pong timestamp — a half-open connection never pong-acks. */
  private lastPongAt = 0;
  /** Terminal job/bench frames dropped while offline, replayed on hello-ok. */
  private pendingTerminal: Array<Extract<AgentServerMsg, { type: "job-done" | "bench-done" }>> = [];
  private readonly buffer: HardwareSnapshot[] = [];
  private snapshotTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private llm: LlmRuntimeConfig;
  private llmTimer: NodeJS.Timeout | undefined;
  private llmProbing = false;
  private nasRoot: string | null = null;
  /** IR-101: cache owner for transfers from the last config-update (null = agent user). */
  private cacheUser: string | null = null;
  /** IRI-019: global HF token from the last config-update (null = unset/cleared). */
  private hfToken: string | null = null;
  /** IR-105: hub-pinned modelctl version from the last config-update (null = env fallback). */
  private modelctlPin: string | null = null;

  constructor(options: AgentTransportOptions) {
    this.token = options.token;
    this.hostname = options.hostname;
    this.agentVersion = options.agentVersion;
    this.schemaVersion = options.schemaVersion;
    this.collect = options.collect;
    this.cadenceMs = options.cadenceMs;
    this.llm = options.llm ?? { llmPorts: [], llmCadenceMs: 0, llmDetectOnly: false };
    this.onLlmConfig = options.onLlmConfig;
    this.collectLlm = options.collectLlm;
    this.onJobRequest = options.onJobRequest;
    this.onJobCancel = options.onJobCancel;
    this.onCatalogRequest = options.onCatalogRequest;
    this.onBenchRun = options.onBenchRun;
    this.onBenchCancel = options.onBenchCancel;
    this.onSetupStart = options.onSetupStart;
    this.onSetupStop = options.onSetupStop;
    this.onSetupStatus = options.onSetupStatus;
    this.onSetupLogAttach = options.onSetupLogAttach;
    this.onSetupValidate = options.onSetupValidate;
    this.onClocksGet = options.onClocksGet;
    this.onClocksSet = options.onClocksSet;
    this.onUsageAck = options.onUsageAck;
    this.onLogAck = options.onLogAck;
    this.onReconnect = options.onReconnect;
    this.getActiveJobIds = options.getActiveJobIds;
    this.maxBufferedSnapshots = options.maxBufferedSnapshots ?? MAX_BUFFERED_SNAPSHOTS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
    this.log = options.log ?? (() => {});
  }

  /** Server-assigned node id once the hello handshake completed. */
  getNodeId(): string | null {
    return this.nodeId;
  }

  /** Current snapshot cadence in ms (hello-ok / config-update driven). */
  getCadenceMs(): number {
    return this.cadenceMs;
  }

  /** True while a connection is authenticated and may carry snapshots. */
  isReady(): boolean {
    return this.ready;
  }

  /** Effective LLM probe config (server values merged with env overrides). */
  getLlmConfig(): LlmRuntimeConfig {
    return this.llm;
  }

  /** NAS store root from the last config-update (model-ops nodes). */
  getNasRoot(): string | null {
    return this.nasRoot;
  }

  /** IR-101: cache owner for transfers from the last config-update. */
  getCacheUser(): string | null {
    return this.cacheUser;
  }

  /**
   * IRI-019: global HF token from the last config-update; null until the
   * hub sends one (or after it sends `hfToken: null` — env fallback wins).
   */
  getHfToken(): string | null {
    return this.hfToken;
  }

  /** IR-105: hub-pinned modelctl version; null = the env pin applies. */
  getModelctlPin(): string | null {
    return this.modelctlPin;
  }

  /** Snapshots currently buffered for the next connection. */
  getBufferedCount(): number {
    return this.buffer.length;
  }

  /**
   * Sends one usage batch; false when offline or the socket rejected it.
   * Never WS-buffered — the durable node buffer owns retries (ADR-0008 §3).
   */
  sendUsageBatch(events: UsageRequest[]): boolean {
    if (!this.ready) return false;
    try {
      this.sendRaw({ type: "usage-batch", schemaVersion: this.schemaVersion, agentVersion: this.agentVersion, events });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * IRI-078: sends one durable log batch with the agent's cumulative drop
   * count; false when offline or the socket rejected it. Never WS-buffered —
   * the durable log buffer owns retries (usage-batch contract).
   */
  sendLogBatch(events: LogEvent[], dropped: number): boolean {
    if (!this.ready) return false;
    try {
      this.sendRaw({
        type: "log-batch",
        schemaVersion: this.schemaVersion,
        agentVersion: this.agentVersion,
        events,
        dropped,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Open the connection and start managing it. Call once. */
  connect(serverUrl: string): void {
    if (this.serverUrl !== null) {
      throw new Error("AgentTransport is already connected");
    }
    this.serverUrl = serverUrl;
    this.startLlmTimer();
    this.open();
  }

  /**
   * Collect one snapshot and send it as {type:"snapshot"}; buffer it
   * (drop-oldest) while the connection is not ready.
   */
  async sendSnapshot(): Promise<void> {
    const snapshot = await this.collect();
    if (this.ready) {
      try {
        this.sendRaw({ type: "snapshot", snapshot });
        return;
      } catch {
        // Socket went away mid-send; the close handler schedules a reconnect.
      }
    }
    this.buffer.push(snapshot);
    while (this.buffer.length > this.maxBufferedSnapshots) {
      this.buffer.shift();
    }
  }

  /** Stop the agent: clear timers, close the socket, never reconnect. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    clearInterval(this.llmTimer);
    this.llmTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    if (ws === null || ws.readyState === WebSocket.CLOSED) return;

    const closed = Promise.withResolvers<void>();
    // Safety valve so a wedged socket cannot hang shutdown forever.
    const deadline = setTimeout(closed.resolve, 1000);
    ws.once("close", () => {
      clearTimeout(deadline);
      closed.resolve();
    });
    try {
      ws.close();
    } catch {
      clearTimeout(deadline);
      closed.resolve();
    }
    await closed.promise;
  }

  private open(): void {
    const ws = new WebSocket(this.serverUrl!);
    this.ws = ws;
    ws.on("open", () => this.handleOpen());
    ws.on("message", (data) => this.handleMessage(data));
    ws.on("error", (err: Error) => {
      this.log(`connection error: ${err.message}`);
    });
    ws.on("close", () => this.handleClose());
  }

  private handleOpen(): void {
    this.log(`connected to ${this.serverUrl}`);
    this.lastPongAt = Date.now();
    try {
      this.sendRaw({
        type: "hello",
        schemaVersion: this.schemaVersion,
        agentVersion: this.agentVersion,
        token: this.token,
        hostname: this.hostname,
        // IR-131: pre-ack agents omit the field; the hub then skips its
        // orphan reconcile (a blip reconnect still has live jobs).
        ...(this.getActiveJobIds !== undefined ? { activeJobs: this.getActiveJobIds() } : {}),
      });
    } catch {
      // handleClose takes over; nothing else to do here.
    }
    this.pingTimer = setInterval(() => {
      try {
        if (this.ready) {
          this.sendRaw({ type: "ping", t: Date.now() });
          // A half-open connection (sleep, NAT drop) sends fine but never
          // pongs — terminate so handleClose schedules a reconnect.
          if (Date.now() - this.lastPongAt > this.pingIntervalMs * 2) {
            this.log("ping timeout — terminating unresponsive connection");
            this.ws?.terminate();
            return;
          }
        }
      } catch {
        // Connection is going away; close handler cleans up.
      }
    }, this.pingIntervalMs);
  }

  private handleMessage(data: WebSocket.RawData): void {
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(frameText(data));
    } catch {
      this.log("dropping non-JSON server frame");
      return;
    }
    const parsed = serverMsgSchema.safeParse(parsedUnknown);
    if (!parsed.success) {
      this.log("dropping unrecognized server frame");
      return;
    }
    switch (parsed.data.type) {
      case "hello-ok":
        this.handleHelloOk(parsed.data.nodeId, parsed.data.cadenceMs);
        break;
      case "config-update":
        this.handleConfigUpdate(parsed.data);
        break;
      case "pong":
        this.lastPongAt = Date.now();
        break;
      case "job":
        this.onJobRequest?.(parsed.data.jobId, parsed.data.kind, parsed.data.params);
        break;
      case "job-cancel":
        this.onJobCancel?.(parsed.data.jobId);
        break;
      case "catalog-request":
        this.onCatalogRequest?.();
        break;
      case "bench-run": {
        const { runId, bench, config } = parsed.data;
        if (this.onBenchRun === undefined) {
          this.sendAgentServer({ type: "bench-done", runId, status: "failed", error: "agent does not support benchmarks" });
          break;
        }
        this.onBenchRun(runId, bench, config);
        break;
      }
      case "bench-cancel":
        this.onBenchCancel?.(parsed.data.runId);
        break;
      case "setup-start": {
        const { setupId, runId, scriptStart, scriptStop, env, modelPathName, capture } = parsed.data;
        if (this.onSetupStart === undefined) {
          this.sendAgentMsg({ type: "setup-ack", setupId, ok: false, error: "agent does not support setups" });
          break;
        }
        void this.onSetupStart(setupId, runId, scriptStart, scriptStop, env, modelPathName, capture)
          .then((result) => this.sendAgentMsg({ type: "setup-ack", setupId, ok: result.ok, error: result.error }))
          .catch((err: unknown) =>
            this.sendAgentMsg({
              type: "setup-ack",
              setupId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        break;
      }
      case "setup-stop": {
        const { setupId, gracefulMs } = parsed.data;
        if (this.onSetupStop === undefined) {
          this.sendAgentMsg({ type: "setup-ack", setupId, ok: false, error: "agent does not support setups" });
          break;
        }
        void this.onSetupStop(setupId, gracefulMs)
          .then((result) => this.sendAgentMsg({ type: "setup-ack", setupId, ok: result.ok, error: result.error }))
          .catch((err: unknown) =>
            this.sendAgentMsg({
              type: "setup-ack",
              setupId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        break;
      }
      case "setup-status":
        this.onSetupStatus?.(parsed.data.setupId);
        break;
      case "setup-log-attach":
        this.onSetupLogAttach?.(parsed.data.setupId, parsed.data.lastSeq);
        break;
      case "setup-validate":
        this.onSetupValidate?.(parsed.data.validateId, parsed.data.scripts);
        break;
      case "clocks-get":
        this.onClocksGet?.(parsed.data.id);
        break;
      case "clocks-set":
        this.onClocksSet?.(parsed.data.id, parsed.data.smMaxMHz);
        break;
      case "usage-batch-ack":
        this.onUsageAck?.(parsed.data.ids);
        break;
      case "log-batch-ack":
        this.onLogAck?.(parsed.data.ids);
        break;
      case "error":
        // Harmless frame-reject (e.g. our job frames on an older server) or a
        // real refusal — log it; closing here would drop in-flight job output.
        this.log(`server error: ${parsed.data.message}`);
        break;
    }
  }

  private handleHelloOk(nodeId: string, cadenceMs: number): void {
    this.nodeId = nodeId;
    this.reconnectAttempts = 0;
    this.ready = true;
    this.cadenceMs = cadenceMs;
    this.log(`handshake ok (node ${nodeId}, cadence ${cadenceMs} ms)`);
    this.flushBuffered();
    // Terminal frames lost while offline: the server's one-active slot must
    // learn the job/bench ended (replays may race a 60 s reaper — fine, both
    // settle the row).
    for (const msg of this.pendingTerminal.splice(0)) this.sendAgentServer(msg);
    this.startSnapshotTimer();
    this.onReconnect?.();
  }

  private handleConfigUpdate(msg: Extract<ServerMsg, { type: "config-update" }>): void {
    this.cadenceMs = msg.cadenceMs;
    this.nasRoot = msg.nasRoot ?? null;
    // IR-101: null (or absent — old server) = the agent's own user (root).
    this.cacheUser = msg.cacheUser ?? null;
    // IRI-019: string = set, null = clear (env fallback applies), absent
    // (old server) = keep the current value.
    if (msg.hfToken !== undefined) this.hfToken = msg.hfToken;
    // IR-105: string = converge to the hub pin, null = clear (env fallback
    // applies), absent (old server) = keep the current value.
    if (msg.modelctlPin !== undefined) this.modelctlPin = msg.modelctlPin;
    this.log(`cadence updated to ${msg.cadenceMs} ms`);
    if (this.ready) this.startSnapshotTimer();

    const serverConfig: LlmRuntimeConfig = {
      llmPorts: msg.llmPorts.map((p) => ({ port: p.port, host: p.host })),
      llmCadenceMs: msg.llmCadenceMs,
      llmDetectOnly: msg.llmDetectOnly,
    };
    const effective = this.onLlmConfig?.(serverConfig) ?? serverConfig;
    if (
      this.llm.llmCadenceMs !== effective.llmCadenceMs ||
      this.llm.llmDetectOnly !== effective.llmDetectOnly ||
      this.llmPortsKey(effective) !== this.llmPortsKey(this.llm)
    ) {
      this.log(
        `llm probes: ${effective.llmPorts.length} port(s), cadence ${effective.llmCadenceMs} ms` +
          `${effective.llmDetectOnly ? ", detection-only" : ""}`,
      );
    }
    this.llm = effective;
    this.startLlmTimer();
  }

  /** Stable ordering key for a port list (change detection only). */
  private llmPortsKey(cfg: LlmRuntimeConfig): string {
    return cfg.llmPorts.map((p) => `${p.host}:${p.port}`).sort().join(",");
  }

  private handleClose(): void {
    this.ready = false;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    clearInterval(this.snapshotTimer);
    this.snapshotTimer = undefined;
    if (this.stopped || this.serverUrl === null) return;

    const attempt = this.reconnectAttempts++;
    const base = Math.min(RECONNECT_MAX_MS, this.reconnectBaseMs * 2 ** attempt);
    const delay = Math.min(RECONNECT_MAX_MS, Math.round(base * (0.75 + Math.random() * 0.5)));
    this.log(`disconnected; reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.open();
    }, delay);
  }

  private startSnapshotTimer(): void {
    clearInterval(this.snapshotTimer);
    this.snapshotTimer = setInterval(() => void this.tick(), this.cadenceMs);
  }

  private startLlmTimer(): void {
    clearInterval(this.llmTimer);
    this.llmTimer = undefined;
    if (this.collectLlm === undefined || this.llm.llmPorts.length === 0) return;
    if (this.llm.llmCadenceMs <= 0) return; // 0 = probes disabled
    this.llmTimer = setInterval(() => void this.llmTick(), this.llm.llmCadenceMs);
  }

  private async llmTick(): Promise<void> {
    if (this.llmProbing || !this.ready || this.collectLlm === undefined) return;
    this.llmProbing = true;
    try {
      const ports = await this.collectLlm(this.llm.llmDetectOnly);
      this.sendLlm(ports);
    } catch (err) {
      this.log(`llm probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.llmProbing = false;
    }
  }

  /**
   * Send one llm frame for the given port snapshots. LLM samples are
   * point-in-time — unlike snapshots they are never buffered offline.
   */
  sendLlm(ports: LlmPortSnapshot[]): void {
    if (!this.ready) return;
    try {
      this.sendRaw({
        type: "llm",
        schemaVersion: this.schemaVersion,
        agentVersion: this.agentVersion,
        ports,
      });
    } catch {
      // Socket went away mid-send; the close handler schedules a reconnect.
    }
  }

  /**
   * Send a job-output / job-done / catalog frame. Dropped while offline —
   * job output is streamed live and job completion is reported to the server
   * directly (the server-side record drives the UI).
   */
  sendAgentServer(msg: AgentServerMsg): void {
    if (!this.ready) {
      if (msg.type === "job-done" || msg.type === "bench-done") {
        // Losing a terminal frame strands the server's one-active slot until
        // manual cancel — buffer and replay on the next hello-ok.
        this.pendingTerminal.push(msg);
        while (this.pendingTerminal.length > MAX_BUFFERED_TERMINAL) this.pendingTerminal.shift();
        this.log(`agentServer frame buffered (not ready): ${msg.type}`);
        return;
      }
      this.log(`agentServer frame DROPPED (not ready): ${msg.type}`);
      return;
    }
    try {
      this.sendRaw(msg);
      if (msg.type !== "job-output") this.log(`agentServer frame sent: ${msg.type}`);
    } catch (err) {
      this.log(`agentServer frame send failed: ${msg.type} (${err instanceof Error ? err.message : String(err)})`);
      if (msg.type === "job-done" || msg.type === "bench-done") {
        this.pendingTerminal.push(msg);
        while (this.pendingTerminal.length > MAX_BUFFERED_TERMINAL) this.pendingTerminal.shift();
      }
    }
  }

  /**
   * Send any agent frame (setup events/logs/acks). Dropped while offline —
   * driver state is re-reported on the next config-update or status poll.
   */
  sendAgentMsg(msg: AgentMsg | Extract<AgentServerMsg, { type: "setup-event" | "setup-log" }>): void {
    if (!this.ready) {
      this.log(`agent frame DROPPED (not ready): ${msg.type}`);
      return;
    }
    try {
      this.sendRaw(msg);
    } catch {
      // Socket going away; the close handler schedules a reconnect.
    }
  }

  private async tick(): Promise<void> {
    if (this.collecting || !this.ready) return;
    this.collecting = true;
    try {
      await this.sendSnapshot();
    } catch (err) {
      this.log(`snapshot collection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.collecting = false;
    }
  }

  private flushBuffered(): void {
    while (this.buffer.length > 0) {
      const snapshot = this.buffer[0]!;
      try {
        this.sendRaw({ type: "snapshot", snapshot });
      } catch {
        return; // Socket went away; keep the rest for the next handshake.
      }
      this.buffer.shift();
    }
  }

  private sendRaw(msg: AgentMsg | AgentServerMsg): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    ws.send(JSON.stringify(msg));
  }
}

function frameText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}
