import { parsePending, type UsageBuffer } from "./usage-buffer.js";
import { USAGE_EVENT_HARD_CAP_BYTES, type UsageRequest } from "@irori/core";

/**
 * Usage sync engine (M8, ADR-0008 §4): batched upload of the durable buffer
 * over the agent WS with ack-driven deletion. One batch in flight; rows not
 * acked stay for the next tick (redelivery is a server-side no-op by UUID).
 *
 * IR-178: single events over USAGE_EVENT_HARD_CAP_BYTES are quarantined
 * (metadata kept, bodies dropped) instead of retrying forever, and a 1009
 * close (hub refused the frame) halves the next take until a batch acks.
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
  /** IR-178: last WS close code from the transport (1009 → shrink). */
  lastCloseCode?: () => number | null;
  /** IR-178: hard cap per serialized event (tests shrink it). */
  eventHardCapBytes?: number;
  log?: (message: string) => void;
}

const ACK_TIMEOUT_MS = 15_000;

export class UsageSync {
  private readonly deps: UsageSyncDeps;
  private readonly ackTimeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private ackWaiter: { ids: Set<string>; resolve: (ok: boolean) => void } | null = null;
  /** IR-178: take batchSize/shrink rows after a 1009 close; reset on ack. */
  private shrink = 1;
  private readonly eventHardCapBytes: number;

  constructor(deps: UsageSyncDeps) {
    this.deps = deps;
    this.ackTimeoutMs = deps.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.eventHardCapBytes = deps.eventHardCapBytes ?? USAGE_EVENT_HARD_CAP_BYTES;
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
        // IR-178: after a frame-too-large close (1009) take progressively
        // smaller slices of the same oldest rows until one batch acks.
        const rows = this.deps.buffer.takeBatch(Math.max(1, Math.floor(this.deps.batchSize / this.shrink)));
        if (rows.length === 0) return;
        const events: UsageRequest[] = [];
        const quarantined: string[] = [];
        for (const row of rows) {
          // IR-178: a single event over the hard cap would poison the
          // connection forever — park it (metadata only) and keep draining.
          if (Buffer.byteLength(row.payload) > this.eventHardCapBytes) {
            const parsed = parsePending(row);
            this.deps.buffer.quarantine(
              row.id,
              "oversized",
              Buffer.byteLength(row.payload),
              parsed === null
                ? {}
                : { ts: parsed.ts, model: parsed.model, endpoint: parsed.endpoint, port: parsed.port, status: parsed.status, setupId: parsed.setupId },
            );
            quarantined.push(row.id);
            continue;
          }
          const parsed = parsePending(row);
          if (parsed !== null) events.push(parsed);
        }
        if (quarantined.length > 0) {
          this.deps.buffer.remove(quarantined);
          this.deps.log?.(`usage: quarantined ${quarantined.length} oversized event(s) (metadata kept, bodies dropped)`);
        }
        if (events.length === 0) {
          // Unparsable rows (schema drift) — drop them; capture never blocks.
          this.deps.buffer.remove(rows.filter((r) => !quarantined.includes(r.id)).map((r) => r.id));
          continue;
        }
        const ok = await this.sendBatch(events);
        if (!ok) {
          // IR-178: a 1009 close means the hub refused the frame — halve and
          // retry instead of resending the same oversized batch forever.
          // Plain timeouts/offline keep the rows and wait for the next tick.
          if (this.deps.lastCloseCode?.() === 1009 && this.shrink < 64) {
            this.shrink *= 2;
            continue;
          }
          return; // rows remain; next tick retries
        }
        this.shrink = 1;
        this.deps.buffer.remove(rows.filter((r) => !quarantined.includes(r.id)).map((r) => r.id));
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
