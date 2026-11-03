import { randomUUID } from "node:crypto";
import { levelFromLine, type LogEvent, type LogLevel, type LogScope, type LogSource } from "@irori/core";
import { parsePendingLog, type LogBuffer } from "./log-buffer.js";

/**
 * Write-behind log sink (IRI-078): the driver/proxy/job emitters push lines
 * into a bounded in-memory queue — an emit is O(1) and NEVER blocks on I/O,
 * so a flooding engine cannot stall the setup driver. A tick drains the
 * queue into the durable LogBuffer and ships batches over the WS with
 * ack-driven deletion (the usage-buffer pattern, ADR-0008 §3-4). Overflow
 * drops OLDEST and counts them; the count rides every batch so the hub can
 * show truncation instead of hiding it.
 */

export interface LogSinkDeps {
  buffer: LogBuffer;
  /** Current transport connectivity (ship only while ready). */
  connected: () => boolean;
  /** Sends one batch (+ cumulative drops); false when offline / send failed. */
  send: (events: LogEvent[], dropped: number) => boolean;
  /** Server → agent ack for the ids of the last sent batch. */
  onAck: (handler: (ids: string[]) => void) => void;
  flushMs: number;
  /** Max events per WS batch (core MAX_LOG_BATCH). */
  batchSize: number;
  /** In-memory queue cap — exceeded lines drop oldest (counted). */
  queueMax: number;
  /** Ack deadline per batch (tests shrink it). */
  ackTimeoutMs?: number;
  log?: (message: string) => void;
}

const ACK_TIMEOUT_MS = 15_000;

/** What an emitter provides; the sink fills id/ts/level defaults. */
export interface LogEmit {
  scope: LogScope;
  setupId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  level?: LogLevel;
  source: LogSource;
  seq?: number | null;
  line: string;
}

export class LogSink {
  private readonly deps: LogSinkDeps;
  private readonly ackTimeoutMs: number;
  private queue: LogEvent[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;
  private ackWaiter: { ids: Set<string>; resolve: (ok: boolean) => void } | null = null;

  constructor(deps: LogSinkDeps) {
    this.deps = deps;
    this.ackTimeoutMs = deps.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.deps.onAck((ids) => {
      const waiter = this.ackWaiter;
      if (waiter === null || ids.length === 0) return;
      if (!waiter.ids.has(ids[0]!)) return; // stale ack for an older attempt
      this.ackWaiter = null;
      waiter.resolve(true);
    });
  }

  /** Cumulative drop count (queue overflow + buffer cap evictions). */
  droppedTotal(): number {
    return this.dropped + this.deps.buffer.droppedTotal();
  }

  /** Queue depth pending the next drain (tests assert backpressure bounds). */
  get queued(): number {
    return this.queue.length;
  }

  /** Test seam: raw queue rows in insertion order (oldest first). */
  queuedSnapshot(): Array<{ payload: string }> {
    return this.queue.map((e) => ({ payload: JSON.stringify(e) }));
  }

  /**
   * O(1), never throws, never awaits. Level defaults to the heuristic on the
   * line; a truncation marker keeps the operator honest about gaps.
   */
  emit(input: LogEmit): void {
    try {
      const event: LogEvent = {
        eventId: randomUUID(),
        ts: Date.now(),
        scope: input.scope,
        setupId: input.setupId ?? null,
        runId: input.runId ?? null,
        jobId: input.jobId ?? null,
        level: input.level ?? levelFromLine(input.line),
        source: input.source,
        seq: input.seq ?? null,
        line: input.line.length > 16384 ? `${input.line.slice(0, 16383)}…` : input.line,
      };
      this.queue.push(event);
      while (this.queue.length > this.deps.queueMax) {
        this.queue.shift();
        this.dropped += 1;
      }
    } catch (err) {
      // A sink failure must never propagate into the driver hot path.
      this.deps.log?.(`log emit failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.flush(), this.deps.flushMs);
    this.timer.unref();
    void this.flush();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Drains the queue into the durable buffer, then ships buffered batches
   * while connected and acked. Awaitable so tests (and shutdown) can force
   * one complete cycle; idempotent under concurrent calls.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      this.drainQueue();
      for (;;) {
        if (!this.deps.connected()) return;
        const rows = this.deps.buffer.takeBatch(this.deps.batchSize);
        if (rows.length === 0) return;
        const events: LogEvent[] = [];
        const ids: string[] = [];
        for (const row of rows) {
          const parsed = parsePendingLog(row);
          if (parsed !== null) events.push(parsed);
          ids.push(row.id);
        }
        if (events.length === 0) {
          // Unparsable rows (schema drift) — drop them; logging never blocks.
          this.deps.buffer.remove(ids);
          continue;
        }
        const ok = await this.sendBatch(events);
        if (!ok) return; // rows remain; next tick retries (hub dedupes)
        this.deps.buffer.remove(ids);
      }
    } catch (err) {
      // A buffer/SQLite failure must never crash the agent as an unhandled
      // rejection — rows stay (durable) and the next tick retries.
      this.deps.log?.(`log flush failed (rows retained): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.flushing = false;
    }
  }

  /** Queue → buffer, bounded per tick so shutdown flush can't stall on a
   *  flood; the remainder goes out on the next tick. */
  private drainQueue(): void {
    const n = Math.min(this.queue.length, this.deps.batchSize);
    for (let i = 0; i < n; i += 1) {
      const event = this.queue.shift();
      if (event === undefined) break;
      try {
        this.deps.buffer.add(event);
      } catch (err) {
        this.queue.unshift(event); // keep it queued — retry next tick
        this.deps.log?.(`log buffer insert failed (queued for retry): ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
  }

  private sendBatch(events: LogEvent[]): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const waiter: { ids: Set<string>; resolve: (ok: boolean) => void } = {
      ids: new Set(events.map((e) => e.eventId)),
      resolve: (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      },
    };
    const timer = setTimeout(() => {
      if (this.ackWaiter?.ids === waiter.ids) this.ackWaiter = null;
      resolve(false);
    }, this.ackTimeoutMs);
    this.ackWaiter = waiter;
    if (!this.deps.send(events, this.droppedTotal())) {
      this.ackWaiter = null;
      clearTimeout(timer);
      resolve(false);
    }
    return promise;
  }
}
