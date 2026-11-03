import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LogBuffer, parsePendingLog } from "../src/log-buffer.js";
import { LogSink, type LogEmit } from "../src/log-sink.js";
import type { LogEvent } from "@irori/core";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "irori-logs-"));
  dirs.push(d);
  return d;
}

let n = 0;
function event(overrides: Partial<LogEvent> = {}): LogEvent {
  n += 1;
  return {
    eventId: randomUUID(),
    ts: 1_700_000_000_000 + n,
    scope: "setup",
    setupId: null,
    runId: null,
    jobId: null,
    level: "info",
    source: "driver",
    seq: n,
    line: `line ${n}`,
    ...overrides,
  };
}

describe("LogBuffer", () => {
  it("persists across reopenings and dedupes by eventId", () => {
    const dir = makeDir();
    const first = new LogBuffer(dir);
    const ev = event();
    first.add(ev);
    expect(first.count()).toBe(1);
    first.add(ev); // duplicate eventId → no-op
    expect(first.count()).toBe(1);
    first.close();

    // The agent restart reopens the same file: durable rows survive.
    const second = new LogBuffer(dir);
    expect(second.count()).toBe(1);
    const batch = second.takeBatch(10);
    expect(batch).toHaveLength(1);
    expect(parsePendingLog(batch[0]!)?.eventId).toBe(ev.eventId);
    second.close();
  });

  it("takes oldest-first batches and removes acked rows", () => {
    const dir = makeDir();
    const buf = new LogBuffer(dir);
    for (let i = 1; i <= 5; i += 1) buf.add(event({ seq: i }));
    const batch = buf.takeBatch(3);
    expect(batch.map((r) => parsePendingLog(r)!.seq)).toEqual([1, 2, 3]);
    buf.remove(batch.map((r) => r.id));
    expect(buf.count()).toBe(2);
    expect(buf.takeBatch(3).map((r) => parsePendingLog(r)!.seq)).toEqual([4, 5]);
    buf.close();
  });

  it("caps rows drop-oldest and counts the drops", () => {
    const dir = makeDir();
    const buf = new LogBuffer(dir);
    for (let i = 1; i <= 10; i += 1) buf.add(event({ seq: i }), 4);
    expect(buf.count()).toBe(4);
    expect(buf.droppedTotal()).toBe(6);
    // OLDEST dropped: the newest four survive (drop-oldest under cap).
    expect(buf.takeBatch(10).map((r) => parsePendingLog(r)!.seq)).toEqual([7, 8, 9, 10]);
    buf.close();
  });

  it("counts drops across reopens (durable counter)", () => {
    const dir = makeDir();
    const first = new LogBuffer(dir);
    for (let i = 0; i < 6; i += 1) first.add(event(), 2);
    expect(first.droppedTotal()).toBe(4);
    first.close();
    const second = new LogBuffer(dir);
    for (let i = 0; i < 3; i += 1) second.add(event(), 2);
    expect(second.droppedTotal()).toBe(7); // 4 + 3 (cumulative)
    second.close();
  });
});

describe("LogSink backpressure + ship", () => {
  /** Sink whose send auto-acks (the hub answers after a durable insert). */
  function autoAckSink(dir: string, opts: { batchSize: number; queueMax: number; online?: () => boolean; onSend?: (ids: string[]) => void }) {
    const buffer = new LogBuffer(dir);
    let ackHandler: ((ids: string[]) => void) | null = null;
    const sink = new LogSink({
      buffer,
      connected: opts.online ?? (() => true),
      send: (events) => {
        const ids = events.map((e) => e.eventId);
        opts.onSend?.(ids);
        ackHandler!(ids); // hub acks after the durable insert
        return true;
      },
      onAck: (handler) => {
        ackHandler = handler;
      },
      flushMs: 60_000,
      batchSize: opts.batchSize,
      queueMax: opts.queueMax,
    });
    return { sink, buffer };
  }

  it("never blocks the driver: bounded queue, drop-oldest counted", () => {
    const dir = makeDir();
    const buffer = new LogBuffer(dir);
    let acked: ((ids: string[]) => void) | null = null;
    const sink = new LogSink({
      buffer,
      connected: () => false, // never ship — pure backpressure behavior
      send: () => false,
      onAck: (handler) => {
        acked = handler;
      },
      flushMs: 60_000,
      batchSize: 200,
      queueMax: 50,
    });
    void acked;
    // Flood far past the cap: emit is O(1) per line and returns immediately.
    const started = performance.now();
    for (let i = 0; i < 5000; i += 1) sink.emit({ scope: "setup", source: "engine", line: `flood ${i}` });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2_000); // 5k synchronous O(1) emits — no I/O on the hot path
    expect(sink.queued).toBe(50);
    expect(sink.droppedTotal()).toBe(5000 - 50);
    // Drop-oldest: the queue holds the NEWEST 50 lines.
    const queuedLines = sink.queuedSnapshot().map((r) => (JSON.parse(r.payload) as LogEvent).line);
    expect(queuedLines[0]).toBe("flood 4950");
    expect(queuedLines[49]).toBe("flood 4999");
  });

  it("drains the queue into the durable buffer and ships batches with ack", async () => {
    const dir = makeDir();
    const sentBatches: string[][] = [];
    const { sink, buffer } = autoAckSink(dir, { batchSize: 3, queueMax: 100, onSend: (ids) => sentBatches.push(ids) });
    for (let i = 0; i < 5; i += 1) sink.emit({ scope: "setup", source: "driver", line: `l${i}` });
    await sink.flush();
    expect(sentBatches).toHaveLength(1);
    await sink.flush(); // acked rows are gone; the remainder ships
    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[1]!.length).toBe(2);
    expect(buffer.count()).toBe(0);
  });

  it("keeps rows offline and replays them after a restart-shaped reopen", async () => {
    const dir = makeDir();
    // Offline: queue drains to the durable buffer, nothing ships.
    const offline = new LogSink({
      buffer: new LogBuffer(dir),
      connected: () => false,
      send: () => false,
      onAck: () => {},
      flushMs: 60_000,
      batchSize: 10,
      queueMax: 100,
      ackTimeoutMs: 20,
    });
    for (let i = 1; i <= 4; i += 1) offline.emit({ scope: "setup", source: "engine", line: `offline ${i}`, seq: i });
    await offline.flush();
    expect(offline.queued).toBe(0);

    // "Agent restart": a fresh sink+buffer over the same on-disk file.
    const buffer = new LogBuffer(dir);
    expect(buffer.count()).toBe(4);
    const sent: string[] = [];
    const online = new LogSink({
      buffer,
      connected: () => true,
      send: (events) => {
        for (const e of events) sent.push(e.eventId);
        return true;
      },
      onAck: () => {},
      flushMs: 60_000,
      batchSize: 10,
      queueMax: 100,
      ackTimeoutMs: 20,
    });
    await online.flush();
    expect(sent).toHaveLength(4);
    // Rows remain until the ack removes them — and the seqs are the same
    // monotonic sequence the driver produced (no gaps, no duplicates).
    const seqs = buffer.takeBatch(10).map((r) => parsePendingLog(r)!.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it("emits heuristic levels and truncates oversized lines", async () => {
    const dir = makeDir();
    const buffer = new LogBuffer(dir);
    const sink = new LogSink({
      buffer,
      connected: () => false,
      send: () => false,
      onAck: () => {},
      flushMs: 60_000,
      batchSize: 10,
      queueMax: 100,
    });
    sink.emit({ scope: "setup", source: "engine", line: "CUDA out of memory. Tried to allocate 2.5 GiB" });
    sink.emit({ scope: "setup", source: "driver", line: "driver: starting ./start.sh" });
    await sink.flush(); // queue → buffer (offline: nothing ships)
    const rows = buffer.takeBatch(10).map((r) => parsePendingLog(r)!);
    expect(rows[0]!.level).toBe("error");
    expect(rows[1]!.level).toBe("info");
    expect(rows[1]!.source).toBe("driver");
    sink.emit({ scope: "setup", source: "engine", line: "x".repeat(20_000) });
    await sink.flush();
    const big = buffer.takeBatch(10).map((r) => parsePendingLog(r)!).at(-1)!;
    expect(big.line.length).toBe(16_384);
    expect(big.line.endsWith("…")).toBe(true);
  });
});
