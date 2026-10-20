import { parsePending, type UsageBuffer } from "./usage-buffer.js";
import type { UsageRequest } from "@irori/core";

/**
 * Usage sync engine (M8, ADR-0008 §4): batched upload of the durable buffer
 * over the agent WS with ack-driven deletion. One batch in flight; rows not
 * acked stay for the next tick (redelivery is a server-side no-op by UUID).
 */

export interface UsageSyncDeps {
  buffer: UsageBuffer;
  /** Current transport connectivity (flush only while ready). */
  connected: () => boolean;
  /** Sends one batch; false when offline / send failed. */
  send: (events: UsageRequest[]) => boolean;
  /** Server → agent ack for the ids of the last sent batch. */
  onAck: (handler: (ids: string[]) => void) => void;
  flushMs: number;
  batchSize: number;
  keepDays: number;
  maxRows: number;
  /** Ack deadline per batch (tests shrink it). */
  ackTimeoutMs?: number;
  log?: (message: string) => void;
}

const ACK_TIMEOUT_MS = 15_000;

export class UsageSync {
  private readonly deps: UsageSyncDeps;
  private readonly ackTimeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private ackWaiter: { ids: Set<string>; resolve: (ok: boolean) => void } | null = null;

  constructor(deps: UsageSyncDeps) {
    this.deps = deps;
    this.ackTimeoutMs = deps.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.deps.onAck((ids) => {
      const waiter = this.ackWaiter;
      if (waiter === null) return;
      if (ids.length === 0) return;
      if (!waiter.ids.has(ids[0]!)) return; // stale ack for an older attempt
      this.ackWaiter = null;
      waiter.resolve(true);
    });  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.flush(), this.deps.flushMs);
    this.timer.unref();
    // Replays pending rows right after a reconnect, before the first tick.
    void this.flush();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Drains the buffer in batches while connected and acked; idempotent. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        if (!this.deps.connected()) return;
        const rows = this.deps.buffer.takeBatch(this.deps.batchSize);
        if (rows.length === 0) return;
        const events: UsageRequest[] = [];
        for (const row of rows) {
          const parsed = parsePending(row);
          if (parsed !== null) events.push(parsed);
        }
        if (events.length === 0) {
          // Unparsable rows (schema drift) — drop them; capture never blocks.
          this.deps.buffer.remove(rows.map((r) => r.id));
          continue;
        }
        const ok = await this.sendBatch(events);
        if (!ok) return; // rows remain; next tick retries
        this.deps.buffer.remove(rows.map((r) => r.id));
      }
    } catch (err) {
      // A buffer/SQLite failure must never crash the agent as an unhandled
      // rejection — rows stay (durable) and the next tick retries.
      this.deps.log?.(`usage flush failed (rows retained): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.flushing = false;
    }
  }

  private sendBatch(events: UsageRequest[]): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      if (this.ackWaiter?.ids === waiter.ids) this.ackWaiter = null;
      resolve(false);
    }, this.ackTimeoutMs);
    const waiter = { ids: new Set(events.map((e) => e.id)), resolve: (ok: boolean): void => { clearTimeout(timer); resolve(ok); } };
    this.ackWaiter = waiter;
    if (!this.deps.send(events)) {
      this.ackWaiter = null;
      clearTimeout(timer);
      resolve(false);
    }
    return promise;
  }
}
