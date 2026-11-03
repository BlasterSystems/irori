import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDbHandle, logDropCounters, logs, nodes, type Db, type DbHandle } from "@irori/db";
import { logQuerySchema, type LogEvent } from "@irori/core";
import { createLogStore } from "../src/logs-store.js";

/**
 * IRI-078 (epic IR-157 WS4): the durable log store against a REAL Postgres
 * (same convention as audit-db.test.ts — IRORI_TEST_DATABASE_URL at a
 * disposable database). Covers what the route-layer tests cannot: dedupe on
 * redelivery, cross-node search with level filtering, cursor/tail paging,
 * drop-counter truncation, and retention (raw purges, warn+ survives).
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("logs store (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let nodeA: string;
  let nodeB: string;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeA = randomUUID();
    nodeB = randomUUID();
    for (const id of [nodeA, nodeB]) {
      await db.insert(nodes).values({
        id,
        name: `logs-test-${id.slice(0, 8)}`,
        kind: "spark",
        role: "standalone",
        host: "localhost",
        agentTokenHash: "x",
        agentTokenEnc: "x",
      });
    }
    await db.delete(logs);
    await db.delete(logDropCounters);
  });

  afterAll(async () => {
    await db.delete(nodes).where(eq(nodes.id, nodeA));
    await db.delete(nodes).where(eq(nodes.id, nodeB));
    await handle.close();
  });

  let seq = 0;
  const ev = (over: Partial<LogEvent> = {}): LogEvent => {
    seq += 1;
    return {
      eventId: randomUUID(),
      ts: 1_700_000_000_000 + seq,
      scope: "setup",
      setupId: null,
      runId: null,
      jobId: null,
      level: "info",
      source: "engine",
      seq,
      line: `line ${seq}`,
      ...over,
    };
  };

  it("stores batches, dedupes on redelivery, and folds drop counters", async () => {
    const store = createLogStore(db, () => {}, () => 1_700_000_010_000);
    const first = [ev(), ev({ level: "warn", line: "driver: start failed: boom" })];
    const one = await store.ingestBatch(nodeA, first, 0);
    expect(one.inserted).toBe(2);
    expect(one.latestId).not.toBeNull();

    // Redelivery of the SAME batch (agent crash before ack): no-op.
    const replay = await store.ingestBatch(nodeA, first, 0);
    expect(replay.inserted).toBe(2); // accepted count
    const rows = await db.select({ n: logs.id }).from(logs);
    expect(rows.length).toBe(2); // not doubled

    // Drop counter folds in (cumulative max, never decreasing).
    await store.ingestBatch(nodeA, [ev()], 5);
    await store.ingestBatch(nodeA, [ev()], 3); // lower cumulative → ignored
    const [counter] = await db.select().from(logDropCounters);
    expect(Number(counter!.dropped)).toBe(5);
    expect(counter!.lastDropAt).not.toBeNull();
  });

  it("searches across nodes with level filtering", async () => {
    const store = createLogStore(db, () => {}, () => 1_700_000_010_000);
    await store.ingestBatch(nodeA, [ev({ line: "CUDA oom on device 0", level: "error" }), ev({ line: "weights loaded" })], 0);
    await store.ingestBatch(nodeB, [ev({ line: "OOM guard tripped on dgx2", level: "error" })], 0);

    // q matches BOTH nodes; level=error keeps only the two error rows.
    const page = await store.list(logQuerySchema.parse({ q: "oom", level: "error", range: "24h", limit: 50 }));
    expect(page.rows).toHaveLength(2);
    expect(new Set(page.rows.map((r) => r.nodeId))).toEqual(new Set([nodeA, nodeB]));

    // Level filter is inclusive: warn+ includes the warn line but not info.
    const warnPage = await store.list(logQuerySchema.parse({ level: "warn", range: "24h", limit: 50 }));
    expect(warnPage.rows.every((r) => r.level === "warn" || r.level === "error")).toBe(true);
    expect(warnPage.rows.some((r) => r.line === "driver: start failed: boom")).toBe(true);
    // info-only rows exist but are excluded here.
    expect(warnPage.rows.some((r) => r.line === "weights loaded")).toBe(false);
  });

  it("pages backward by cursor and tails ascending by after", async () => {
    const store = createLogStore(db, () => {}, () => 1_700_000_010_000);
    await store.ingestBatch(nodeA, [ev(), ev(), ev(), ev()], 0);
    const all = await store.list(logQuerySchema.parse({ range: "24h", limit: 2 }));
    expect(all.rows).toHaveLength(2);
    expect(all.nextCursor).not.toBeNull();
    // Descending: newest first.
    expect(BigInt(all.rows[0]!.id)).toBeGreaterThan(BigInt(all.rows[1]!.id));

    const older = await store.list(logQuerySchema.parse({ range: "24h", limit: 2, cursor: all.nextCursor! }));
    for (const row of older.rows) expect(BigInt(row.id)).toBeLessThan(BigInt(all.rows[0]!.id));

    // Tail mode: rows after a given id, ascending.
    const after = await store.list(logQuerySchema.parse({ range: "24h", limit: 10, after: all.latestId! }));
    for (const row of after.rows) expect(BigInt(row.id)).toBeGreaterThan(BigInt(all.latestId!));
  });

  it("summarizes counts per level with the same filters", async () => {
    const store = createLogStore(db, () => {}, () => 1_700_000_010_000);
    const summary = await store.summary(logQuerySchema.parse({ range: "24h" }));
    expect(summary.total).toBeGreaterThan(0);
    expect(Object.values(summary.counts).reduce((a, b) => a + b, 0)).toBe(summary.total);

    const byNode = await store.summary(logQuerySchema.parse({ range: "24h", nodeId: nodeB }));
    expect(byNode.counts.error).toBe(1);
  });

  it("flags truncation from drop counters in range", async () => {
    const store = createLogStore(db, () => {}, () => 1_700_000_010_000);
    const page = await store.list(logQuerySchema.parse({ range: "24h", nodeId: nodeA }));
    expect(page.truncated).toBe(true); // nodeA dropped 5 earlier in this suite
    const clean = await store.list(logQuerySchema.parse({ range: "24h", nodeId: nodeB, q: "OOM guard" }));
    expect(clean.truncated).toBe(false);
  });

  it("purges raw past 30 d but keeps warn+ past the raw window", async () => {
    const store = createLogStore(db, () => {}, () => 1_700_000_010_000);
    // Backdate rows directly: 40 d old info + warn, 200 d old warn.
    const oldInfo = ev({ line: "old info", level: "info" });
    const oldWarn = ev({ line: "old warn", level: "warn" });
    const ancient = ev({ line: "ancient warn", level: "error" });
    await store.ingestBatch(nodeA, [oldInfo, oldWarn, ancient], 0);
    const DAY = 24 * 3_600_000;
    const backdate = async (line: string, days: number): Promise<void> => {
      await db.execute(sql`UPDATE logs SET ts = now() - ${`${days} days`}::interval WHERE line = ${line}`);
    };
    await backdate("old info", 40);
    await backdate("old warn", 40);
    await backdate("ancient warn", 200);

    // Raw pass (30 d): info dies, warn survives.
    await store.pruneRaw(new Date(Date.now() - 30 * DAY));
    const lines = (await db.select({ line: logs.line }).from(logs)).map((r) => r.line);
    expect(lines).not.toContain("old info");
    expect(lines).toContain("old warn");

    // Hard pass (180 d): even warn+ dies past the second window.
    await store.pruneAll(new Date(Date.now() - 180 * DAY));
    const after = (await db.select({ line: logs.line }).from(logs)).map((r) => r.line);
    expect(after).not.toContain("ancient warn");
    expect(after).toContain("old warn");
  });
});
