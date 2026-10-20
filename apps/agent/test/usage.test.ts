import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageBuffer, parsePending } from "../src/usage-buffer.js";
import { UsageSync } from "../src/usage-sync.js";
import { usageRequestSchema, type UsageRequest } from "@irori/core";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "irori-usage-"));
  dirs.push(d);
  return d;
}

let seq = 0;
function request(overrides: Partial<UsageRequest> = {}): UsageRequest {
  seq += 1;
  return usageRequestSchema.parse({
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    ts: 1_700_000_000_000 + seq,
    setupId: null,
    port: 8081,
    model: "GLM-5.3-Flash-EXL3",
    endpoint: "/v1/chat/completions",
    stream: true,
    status: 200,
    finishReason: "stop",
    error: null,
    errorSig: null,
    durationMs: 1200,
    ttftMs: 180,
    decodeTps: 41.2,
    promptTokens: 100,
    completionTokens: 42,
    cachedTokens: 10,
    reasoningTokens: 4,
    totalTokens: 142,
    engineMeta: null,
    reqBytes: 1024,
    resBytes: 2048,
    sourceAddr: "127.0.0.1",
    ...overrides,
  });
}

describe("UsageBuffer", () => {
  it("persists across reopenings and dedupes by id", () => {
    const dir = makeDir();
    const first = new UsageBuffer(dir);
    const event = request();
    first.add(event);
    expect(first.count()).toBe(1);
    first.add(event); // duplicate id → no-op
    expect(first.count()).toBe(1);
    first.close();

    const second = new UsageBuffer(dir);
    expect(second.count()).toBe(1); // durable (WAL)
    const batch = second.takeBatch(10);
    expect(batch).toHaveLength(1);
    expect(parsePending(batch[0]!)?.id).toBe(event.id);
    second.close();
  });

  it("takes oldest-first batches and removes acked rows", () => {
    const dir = makeDir();
    const buf = new UsageBuffer(dir);
    for (let i = 0; i < 5; i += 1) buf.add(request());
    const batch = buf.takeBatch(3);
    expect(batch).toHaveLength(3);
    const batchTs = batch.map((r) => parsePending(r)!.ts);
    expect(batchTs).toEqual([...batchTs].sort((a, b) => a - b));
    buf.remove(batch.map((r) => r.id));
    expect(buf.count()).toBe(2);
    expect(buf.takeBatch(3)).toHaveLength(2);
  });

  it("prunes by age and caps rows by insert order", () => {
    const dir = makeDir();
    const buf = new UsageBuffer(dir);
    for (let i = 0; i < 10; i += 1) buf.add(request());
    buf.prune(90, 4); // cap at 4 newest
    expect(buf.count()).toBe(4);
    // A cutoff in the future (negative keep days) deletes everything.
    buf.prune(-1, 200);
    expect(buf.count()).toBe(0);
  });
});

describe("UsageSync", () => {
  it("drains bounded batches end-to-end when the server acks (auto-ack)", async () => {
    const dir = makeDir();
    const buffer = new UsageBuffer(dir);
    for (let i = 0; i < 5; i += 1) buffer.add(request());
    const sent: UsageRequest[][] = [];
    let ackHandler: ((ids: string[]) => void) | null = null;
    const sync = new UsageSync({
      buffer,
      connected: () => true,
      // Auto-ack via microtask: the flush loop continues without test timers.
      send: (events) => {
        sent.push(events);
        queueMicrotask(() => ackHandler?.(events.map((e) => e.id)));
        return true;
      },
      onAck: (h) => {
        ackHandler = h;
      },
      flushMs: 3_600_000, // never ticks — flush() is driven directly
      batchSize: 2,
      keepDays: 90,
      maxRows: 1000,
      ackTimeoutMs: 5_000,
    });
    await sync.flush();
    expect(sent.map((b) => b.length)).toEqual([2, 2, 1]); // bounded batches
    expect(buffer.count()).toBe(0); // deleted only after each ack
    buffer.close();
  });

  it("keeps rows when the ack never arrives and redelivers on the next flush", async () => {
    const dir = makeDir();
    const buffer = new UsageBuffer(dir);
    const event = request();
    buffer.add(event);
    const sent: UsageRequest[][] = [];
    const sync = new UsageSync({
      buffer,
      connected: () => true,
      send: (events) => {
        sent.push(events);
        return true; // no ack — times out
      },
      onAck: () => {},
      flushMs: 3_600_000,
      batchSize: 10,
      keepDays: 90,
      maxRows: 1000,
      ackTimeoutMs: 10, // real 10 ms deadline: this path IS the timing behavior
    });
    await sync.flush();
    expect(sent).toHaveLength(1);
    expect(buffer.count()).toBe(1); // unacked rows stay

    // Second flush redelivers the same row (server dedupes by UUID).
    await sync.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.map((e) => e.id)).toEqual([event.id]);
    expect(buffer.count()).toBe(1);
    buffer.close();
  });

  it("is a no-op while offline and stops cleanly", async () => {
    const dir = makeDir();
    const buffer = new UsageBuffer(dir);
    buffer.add(request());
    const sent: UsageRequest[][] = [];
    const sync = new UsageSync({
      buffer,
      connected: () => false,
      send: (events) => {
        sent.push(events);
        return true;
      },
      onAck: () => {},
      flushMs: 3_600_000,
      batchSize: 10,
      keepDays: 90,
      maxRows: 1000,
      ackTimeoutMs: 10,
    });
    await sync.flush();
    expect(sent).toHaveLength(0);
    expect(buffer.count()).toBe(1);
    sync.stop();
    buffer.close();
  });
});
