import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { UsageBuffer, parsePending } from "../src/usage-buffer.js";
import { UsageSync } from "../src/usage-sync.js";
import { usagePartWireSchema, usageRequestSchema, type UsagePartWire, type UsageRequest } from "@irori/core";

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

/** IR-52 fixture: a content-addressed part plus the canonical bytes it holds. */
function makePart(content: string, overrides: Partial<Omit<UsagePartWire, "gz">> = {}): UsagePartWire {
  const canonical = Buffer.from(content, "utf8");
  return usagePartWireSchema.parse({
    hash: createHash("sha256").update(canonical).digest("hex"),
    kind: "message",
    role: "user",
    index: 0,
    bytes: canonical.length,
    gz: gzipSync(canonical).toString("base64"),
    truncated: false,
    ...overrides,
  });
}

function decoded(part: UsagePartWire): string {
  return gunzipSync(Buffer.from(part.gz, "base64")).toString("utf8");
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

  it("stores parts content-addressed, dedupes them, and re-attaches gz", () => {
    const dir = makeDir();
    const buf = new UsageBuffer(dir);
    const shared = makePart("{\"role\":\"system\",\"content\":\"shared prefix\"}", { index: 0 });
    const only1 = makePart("turn one body", { index: 1 });
    const only2 = makePart("turn two body", { index: 1 });
    buf.add(request({ parts: [shared, only1] }));
    buf.add(request({ parts: [shared, only2] }));
    const batch = buf.takeBatch(10);
    expect(batch).toHaveLength(2);
    const first = parsePending(batch[0]!);
    const second = parsePending(batch[1]!);
    expect(first?.parts).toHaveLength(2);
    expect(second?.parts).toHaveLength(2);
    // gz survived the round trip and decodes to the canonical bytes.
    expect(decoded(first!.parts[0]!)).toBe("{\"role\":\"system\",\"content\":\"shared prefix\"}");
    expect(decoded(first!.parts[1]!)).toBe("turn one body");
    expect(decoded(second!.parts[1]!)).toBe("turn two body");
    // Same hash → same bytes → deduped store.
    expect(first!.parts[0]!.hash).toBe(second!.parts[0]!.hash);
    buf.close();
  });

  it("never re-counts refs on duplicate adds and frees parts with their rows", () => {
    const dir = makeDir();
    const buf = new UsageBuffer(dir);
    const part = makePart("body bytes", { index: 0 });
    const event = request({ parts: [part] });
    buf.add(event);
    buf.add(event); // duplicate capture id — refs must not double
    expect(buf.count()).toBe(1);
    buf.remove([event.id]);
    const batch = buf.takeBatch(10);
    expect(batch).toHaveLength(0); // row gone → part has no refs → nothing re-attaches
    // A part shared by two rows survives the first removal.
    buf.add(request({ parts: [part] }));
    buf.add(request({ parts: [part] }));
    const pairs = buf.takeBatch(10);
    expect(pairs).toHaveLength(2);
    buf.remove([pairs[0]!.id]);
    const remaining = buf.takeBatch(10);
    expect(remaining).toHaveLength(1);
    expect(decoded(parsePending(remaining[0]!)!.parts[0]!)).toBe("body bytes");
    buf.close();
  });

  it("releases part refs for rows dropped by prune", () => {
    const dir = makeDir();
    const buf = new UsageBuffer(dir);
    buf.add(request({ parts: [makePart("dropped with its row", { index: 0 })] }));
    buf.add(request({ parts: [makePart("kept", { index: 0 })] }));
    buf.prune(90, 1); // cap-drop the oldest row
    const batch = buf.takeBatch(10);
    expect(batch).toHaveLength(1);
    expect(decoded(parsePending(batch[0]!)!.parts[0]!)).toBe("kept");
    buf.close();
  });

  it("byte-budgets batches: oversized singletons travel alone", () => {
    const dir = makeDir();
    const buf = new UsageBuffer(dir);
    const big = makePart("x".repeat(10_000), { index: 0 });
    buf.add(request({ parts: [big] }));
    buf.add(request({ parts: [makePart("small", { index: 0 })] }));
    // Budget smaller than the first event's parts: it still travels (alone).
    const first = buf.takeBatch(10, 1_000);
    expect(first).toHaveLength(1);
    expect(parsePending(first[0]!)!.parts[0]!.bytes).toBe(10_000);
    buf.remove(first.map((r) => r.id)); // ack frees the head; oldest-first resumes
    const second = buf.takeBatch(10, 1_000);
    expect(second).toHaveLength(1);
    expect(decoded(parsePending(second[0]!)!.parts[0]!)).toBe("small");
    buf.close();
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
