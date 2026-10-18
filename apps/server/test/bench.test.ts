import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BenchProgress } from "@irori/core";
import { createDbHandle, nodes } from "@irori/db";
import { eq } from "drizzle-orm";
import { createBenchService, BENCH_KEEP_PER_TYPE, type BenchRunRow } from "../src/bench-service.js";
import { createSseHub } from "../src/sse.js";

/**
 * Requires a REAL Postgres (ADR-0002 — no :memory: exists for postgres.js).
 * Same convention as setups.test.ts: IRORI_TEST_DATABASE_URL must point at a
 * DISPOSABLE database. CI starts a Postgres service container for this suite.
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
 *   IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres pnpm --filter @irori/server test
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("bench service (db integration)", () => {
  let handle: ReturnType<typeof createDbHandle>;
  let nodeId: string;
  let sent: Array<{ nodeId: string; msg: unknown }>;
  let service: ReturnType<typeof createBenchService>;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    // Unique node per run so re-runs against a dirty database stay valid.
    nodeId = randomUUID();
    await handle.db.insert(nodes).values({
      id: nodeId,
      name: `bench-test-${nodeId.slice(0, 8)}`,
      kind: "spark",
      role: "standalone",
      host: "localhost",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
    sent = [];
    service = createBenchService(handle.db, (id, msg) => {
      sent.push({ nodeId: id, msg });
      return true;
    }, createSseHub({ heartbeatMs: 0 }));
  });

  afterAll(async () => {
    if (handle) await handle.db.delete(nodes).where(eq(nodes.id, nodeId));
  });

  it("creates, dispatches, and completes a run", async () => {
    const run = await service.start("decode", nodeId, { host: "127.0.0.1", port: 8080, model: null, concurrencies: [1, 2] });
    expect(run.status).toBe("running");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg).toMatchObject({ type: "bench-run", runId: run.id, bench: "decode" });

    const progress: BenchProgress = { phase: "running", index: 1, total: 2, label: "×2", liveTps: 12.5 };
    service.onProgress(nodeId, run.id, progress); // SSE only; must not throw

    await service.onDone(nodeId, run.id, "completed", { levels: [{ concurrency: 1, streamsOk: 1, streamsFailed: 0, meanDecodeTps: 10, medianDecodeTps: 10, minDecodeTps: 10, maxDecodeTps: 10, aggregateDecodeTps: 10, meanTtftMs: 5, medianTtftMs: 5, totalDecodeTokens: 10, totalCompletionTokens: 11, durationMs: 1000, streams: [] }] }, null);
    const done = await service.get(run.id);
    expect(done).toMatchObject({ status: "completed", model: null, port: 8080 });
    expect((done!.result as { levels: unknown[] }).levels).toHaveLength(1);
    expect(done!.finishedAt).not.toBeNull();
    expect(done!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects a second concurrent bench on the same node while one runs", async () => {
    const first = await service.start("prefill", nodeId, { host: "127.0.0.1", port: 8080, model: null, sizes: [1024] });
    await expect(service.start("prefill", nodeId, { host: "127.0.0.1", port: 8080, model: null, sizes: [2048] })).rejects.toThrow(/active benchmark/);
    await service.onDone(nodeId, first.id, "canceled", null, null);
    const after = await service.get(first.id);
    expect(after!.status).toBe("canceled");
    // After the run ended the node is free again.
    const second = await service.start("prefill", nodeId, { host: "127.0.0.1", port: 8080, model: null, sizes: [2048] });
    await service.onDone(nodeId, second.id, "failed", null, "boom");
    expect((await service.get(second.id))!.error).toBe("boom");
  });

  it("validates configs before dispatch", async () => {
    await expect(service.start("decode", nodeId, { host: "127.0.0.1", port: 8080, maxTokens: 4 })).rejects.toThrow();
    await expect(service.start("nope" as "decode", nodeId, {})).rejects.toThrow();
  });

  it("marks running benches failed when the node goes offline", async () => {
    const run = await service.start("tooleval", nodeId, { host: "127.0.0.1", port: 8080, model: null });
    const reaped = await service.reapOffline(new Set());
    expect(reaped).toContain(run.id);
    expect((await service.get(run.id))!.status).toBe("failed");
  });

  it("ignores terminal frames for unknown runs", async () => {
    await service.onDone(nodeId, randomUUID(), "completed", { levels: [] }, null); // must not throw
  });

  it("keeps only the newest rows per type", async () => {
    for (let i = 0; i < BENCH_KEEP_PER_TYPE + 3; i++) {
      const run = await service.start("quality", nodeId, { host: "127.0.0.1", port: 8080, model: null, categories: ["qa"], concurrency: 1 });
      await service.onDone(nodeId, run.id, "completed", { suiteVersion: 1, scoringVersion: 1, total: 1, passed: 1, byCategory: { qa: { total: 1, passed: 1 } }, items: [{ id: "x", category: "qa", pass: true, error: null }] }, null);
    }
    await service.prune();
    const remaining = await service.list("quality", { nodeId });
    expect(remaining.length).toBe(BENCH_KEEP_PER_TYPE);
  });
});
