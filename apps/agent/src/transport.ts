import { WebSocket } from "ws";
import { serverMsgSchema } from "@irori/core";
import type { AgentMsg, HardwareSnapshot } from "@irori/core";

/** Bound on snapshots queued while the connection is down (drop-oldest). */
export const MAX_BUFFERED_SNAPSHOTS = 500;

const DEFAULT_PING_INTERVAL_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

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
  private readonly buffer: HardwareSnapshot[] = [];
  private snapshotTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: AgentTransportOptions) {
    this.token = options.token;
    this.hostname = options.hostname;
    this.agentVersion = options.agentVersion;
    this.schemaVersion = options.schemaVersion;
    this.collect = options.collect;
    this.cadenceMs = options.cadenceMs;
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

  /** Snapshots currently buffered for the next connection. */
  getBufferedCount(): number {
    return this.buffer.length;
  }

  /** Open the connection and start managing it. Call once. */
  connect(serverUrl: string): void {
    if (this.serverUrl !== null) {
      throw new Error("AgentTransport is already connected");
    }
    this.serverUrl = serverUrl;
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
    try {
      this.sendRaw({
        type: "hello",
        schemaVersion: this.schemaVersion,
        agentVersion: this.agentVersion,
        token: this.token,
        hostname: this.hostname,
      });
    } catch {
      // handleClose takes over; nothing else to do here.
    }
    this.pingTimer = setInterval(() => {
      try {
        if (this.ready) this.sendRaw({ type: "ping", t: Date.now() });
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
        this.handleConfigUpdate(parsed.data.cadenceMs);
        break;
      case "pong":
        break;
      case "error":
        this.log(`server error: ${parsed.data.message} — closing`);
        this.ws?.close();
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
    this.startSnapshotTimer();
  }

  private handleConfigUpdate(cadenceMs: number): void {
    this.cadenceMs = cadenceMs;
    this.log(`cadence updated to ${cadenceMs} ms`);
    if (this.ready) this.startSnapshotTimer();
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

  private sendRaw(msg: AgentMsg): void {
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
