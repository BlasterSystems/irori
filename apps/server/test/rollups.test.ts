import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import type { Express } from "express";
import {
  createDbHandle,
  createNodeStore,
  nodes,
  settings,
  snapshotBuckets,
  snapshots,
  type DbHandle,
  type NodeStore,
} from "@irori/db";
import type { HardwareSnapshot } from "@irori/core";
import { computeBuckets, createRollupEngine, ROLLUP_WATERMARK_KEY } from "../src/rollups.js";
import { runRetention } from "../src/retention.js";
import { buildHistory } from "../src/history.js";
import { createApp } from "../src/app.js";
import { createRings } from "../src/rings.js";
import { createSseHub } from "../src/sse.js";
import { makeSnapshot } from "./helpers.js";

/**
 * Requires a REAL Postgres (ADR-0002), like packages/db/test/db.test.ts.
 * IRORI_TEST_DATABASE_URL must point at a DISPOSABLE database:
 *   docker run --rm -d -p 54329:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
 *   IRORI_TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres pnpm --filter @irori/server test
 *
 * Every test creates its own nodes (unique per run) and asserts node-locally,
 * so re-runs against a dirty database stay valid. Tests run in file order;
 * the retention test runs last on purpose. Bucket-keying assertions are
 * server-time only, so they hold regardless of payload timestamps.
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function gpu(partial: Partial<HardwareSnapshot["gpus"][number]> = {}): HardwareSnapshot["gpus"][number] {
  return {
    index: 0,
    name: "GB10",
    uuid: null,
    usagePct: null,
    tempC: null,
    memUsedBytes: null,
    memTotalBytes: null,
    powerW: null,
    powerLimitW: null,
    smClockMHz: null,
    smClockMaxMHz: null,
    throttleReasons: [],
    processes: [],
    ...partial,
  };
}

d("rollups / retention / history (db integration)", () => {
  let h: DbHandle;
  let store: NodeStore;
  const createdIds: string[] = [];

  beforeAll(async () => {
    h = createDbHandle(url!);
    await h.migrate();
    store = createNodeStore(h.db, "a".repeat(64));
  });

  beforeEach(async () => {
    // Watermark tests must not see a watermark left by an earlier test/run.
    await h.db.delete(settings).where(eq(settings.key, ROLLUP_WATERMARK_KEY));
  });

  afterAll(async () => {
    if (createdIds.length > 0) await h.db.delete(nodes).where(inArray(nodes.id, createdIds));
    await h.close();
  });

  async function makeNode(label: string): Promise<string> {
    const { id } = await store.create({
      name: `${label}-${randomUUID()}`,
      kind: "spark",
      role: "head",
      host: `${label}.test`,
    });
    createdIds.push(id);
    return id;
  }

  async function seed(nodeId: string, serverTime: Date, overrides: Partial<HardwareSnapshot> = {}) {
    await h.db.insert(snapshots).values({ nodeId, serverTime, payload: makeSnapshot(overrides) });
  }

  function bucketsFor(granularity: "minute" | "hour" | "day", nodeId: string) {
    return h.db
      .select()
      .from(snapshotBuckets)
      .where(and(eq(snapshotBuckets.nodeId, nodeId), eq(snapshotBuckets.granularity, granularity)))
      .orderBy(snapshotBuckets.bucketStart);
  }

  const starts = (rows: Array<{ bucketStart: Date }>) => rows.map((r) => r.bucketStart.toISOString());

  async function readWatermark(): Promise<unknown> {
    const [row] = await h.db.select().from(settings).where(eq(settings.key, ROLLUP_WATERMARK_KEY));
    return row?.value ?? null;
  }

  function makeApiApp(): Express {
    return createApp({
      getStore: () => store,
      getHistory: () => (id, range) => buildHistory(h.db, id, range),
      dbHealthy: async () => true,
      rings: createRings(),
      sse: createSseHub({ heartbeatMs: 0 }),
      getHub: () => null,
      version: "test",
      staticDir: null,
    });
  }

  it("aggregates minute buckets on UTC boundaries with averages and temp min/avg/max", async () => {
    const nodeId = await makeNode("rollup-a");
    // 10:00 bucket: two samples; 10:01 bucket: one sample. GPU arrays fold
    // per snapshot (usage/temp max, power/mem sum) before averaging.
    await seed(nodeId, new Date("2026-01-15T10:00:10Z"), {
      cpu: { model: "GB10 SoC", cores: 20, usagePct: 10, tempC: 40, packagePowerW: 30 },
      memory: { totalBytes: 128e9, usedBytes: 60e9 },
      gpus: [
        gpu({ index: 0, usagePct: 10, tempC: 40, memUsedBytes: 1e9, powerW: 50 }),
        gpu({ index: 1, usagePct: 90, tempC: 60, memUsedBytes: 2e9, powerW: 70 }),
      ],
      network: [
        { iface: "eth0", rxBps: 1000, txBps: 500 },
        { iface: "eth1", rxBps: 3000, txBps: 1500 },
      ],
    });
    await seed(nodeId, new Date("2026-01-15T10:00:50Z"), {
      cpu: { model: "GB10 SoC", cores: 20, usagePct: 30, tempC: 60, packagePowerW: 40 },
      memory: { totalBytes: 128e9, usedBytes: 80e9 },
      gpus: [gpu({ index: 0, powerW: 100 })], // usage/temp/mem unreadable → nulls skipped
      network: [{ iface: "eth0", rxBps: 2000, txBps: 1000 }],
    });
    await seed(nodeId, new Date("2026-01-15T10:01:20Z"), {
      cpu: { model: "GB10 SoC", cores: 20, usagePct: 50, tempC: 50, packagePowerW: null },
      gpus: [],
      network: [],
    });

    const written = await computeBuckets(
      h.db,
      "minute",
      new Date("2026-01-15T09:59:00Z"),
      new Date("2026-01-15T10:03:00Z"),
    );
    expect(written).toBeGreaterThanOrEqual(0); // includes re-runs of prior nodes' buckets

    const rows = await bucketsFor("minute", nodeId);
    expect(starts(rows)).toEqual(["2026-01-15T10:00:00.000Z", "2026-01-15T10:01:00.000Z"]);
    const [b0, b1] = rows;
    expect(b0!.samples).toBe(2);
    expect(b0!.cpuUsagePct).toBeCloseTo(20);
    expect(b0!.cpuTempC).toBeCloseTo(50);
    expect(b0!.cpuTempMinC).toBeCloseTo(40);
    expect(b0!.cpuTempMaxC).toBeCloseTo(60);
    expect(b0!.packagePowerW).toBeCloseTo(35);
    expect(b0!.memUsedBytes).toBeCloseTo(70e9);
    expect(b0!.memTotalBytes).toBeCloseTo(128e9);
    expect(b0!.gpuUsagePct).toBeCloseTo(90); // avg(90, null)
    expect(b0!.gpuTempC).toBeCloseTo(60); // avg(60, null)
    expect(b0!.gpuTempMinC).toBeCloseTo(60);
    expect(b0!.gpuTempMaxC).toBeCloseTo(60);
    expect(b0!.gpuPowerW).toBeCloseTo(110); // avg(50+70, 100)
    expect(b0!.gpuMemUsedBytes).toBeCloseTo(3e9); // avg(1e9+2e9, null)
    expect(b0!.netRxBps).toBeCloseTo(3000); // avg(1000+3000, 2000)
    expect(b0!.netTxBps).toBeCloseTo(1500);
    expect(b1!.samples).toBe(1);
    expect(b1!.cpuUsagePct).toBeCloseTo(50);
    expect(b1!.cpuTempMinC).toBeCloseTo(50);
    expect(b1!.cpuTempMaxC).toBeCloseTo(50);
    expect(b1!.gpuUsagePct).toBeNull();
    expect(b1!.gpuPowerW).toBeNull();
    expect(b1!.netRxBps).toBeNull();
  });

  it("is a no-op over an empty range", async () => {
    const written = await computeBuckets(
      h.db,
      "minute",
      new Date("2020-01-01T00:00:00Z"),
      new Date("2020-01-02T00:00:00Z"),
    );
    expect(written).toBe(0);
  });

  it("recomputes idempotently over overlapping windows", async () => {
    const nodeId = await makeNode("rollup-b");
    await seed(nodeId, new Date("2026-01-15T10:00:30Z"), {
      cpu: { model: "GB10 SoC", cores: 20, usagePct: 42.5, tempC: 47, packagePowerW: null },
    });

    await computeBuckets(h.db, "minute", new Date("2026-01-15T09:59:00Z"), new Date("2026-01-15T10:03:00Z"));
    const first = await bucketsFor("minute", nodeId);

    // Wider window re-aggregates the same bucket → same numbers, no new rows.
    await computeBuckets(h.db, "minute", new Date("2026-01-15T09:00:00Z"), new Date("2026-01-15T10:03:00Z"));
    const second = await bucketsFor("minute", nodeId);
    expect(second).toEqual(first);
    expect(second).toHaveLength(1);
  });

  it("runOnce skips the open bucket and advances the watermark", async () => {
    const nodeId = await makeNode("rollup-w");
    await seed(nodeId, new Date("2026-02-01T10:00:10Z"), {
      cpu: { model: "GB10 SoC", cores: 20, usagePct: 11, tempC: 41, packagePowerW: null },
    });
    await seed(nodeId, new Date("2026-02-01T10:01:20Z"), {
      cpu: { model: "GB10 SoC", cores: 20, usagePct: 22, tempC: 42, packagePowerW: null },
    });
    const engine = createRollupEngine(h.db);

    // Minute bucket 10:01 completes only at 10:02:00 — must not exist yet.
    // (hour/day watermarks advance too because earlier tests seeded older data.)
    await engine.runOnce(new Date("2026-02-01T10:01:30Z"));
    expect(starts(await bucketsFor("minute", nodeId))).toEqual(["2026-02-01T10:00:00.000Z"]);
    expect(await readWatermark()).toEqual({
      minute: "2026-02-01T10:01:00.000Z",
      hour: "2026-02-01T10:00:00.000Z",
      day: "2026-02-01T00:00:00.000Z",
    });

    await engine.runOnce(new Date("2026-02-01T10:02:30Z"));
    const rows = await bucketsFor("minute", nodeId);
    expect(starts(rows)).toEqual(["2026-02-01T10:00:00.000Z", "2026-02-01T10:01:00.000Z"]);
    expect(rows[1]!.cpuUsagePct).toBeCloseTo(22);
    expect((await readWatermark()) as { minute: string }).toEqual({
      minute: "2026-02-01T10:02:00.000Z",
      hour: "2026-02-01T10:00:00.000Z",
      day: "2026-02-01T00:00:00.000Z",
    });
  });

  it("backfills hour/day buckets from the earliest snapshot when no watermark exists", async () => {
    const nodeId = await makeNode("rollup-w2");
    await seed(nodeId, new Date("2026-02-01T09:30:00Z"), {});
    await seed(nodeId, new Date("2026-02-01T10:00:10Z"), {});
    const engine = createRollupEngine(h.db);

    await engine.runOnce(new Date("2026-02-01T10:01:30Z"));

    // Hour 09:00 is complete; 10:00 is not. The Feb 1 day bucket completes
    // only on Feb 2, so no day rows exist for this node yet.
    expect(starts(await bucketsFor("hour", nodeId))).toEqual(["2026-02-01T09:00:00.000Z"]);
    expect(await bucketsFor("day", nodeId)).toEqual([]);
    expect(starts(await bucketsFor("minute", nodeId))).toEqual([
      "2026-02-01T09:30:00.000Z",
      "2026-02-01T10:00:00.000Z",
    ]);
  });

  it("buckets by server time only — payload timestamps in the future or past are ignored", async () => {
    const nodeId = await makeNode("rollup-c");
    await seed(nodeId, new Date("2026-03-05T08:00:10Z"), { timestampMs: Date.parse("2026-04-10T00:00:00Z") });
    await seed(nodeId, new Date("2026-03-05T08:00:40Z"), { timestampMs: Date.parse("2020-01-01T00:00:00Z") });
    const engine = createRollupEngine(h.db);

    await engine.runOnce(new Date("2026-03-05T08:01:00Z"));

    const rows = await bucketsFor("minute", nodeId);
    expect(starts(rows)).toEqual(["2026-03-05T08:00:00.000Z"]);
    expect(rows[0]!.samples).toBe(2);
  });

  it("retention prunes raw snapshots and every bucket granularity per policy", async () => {
    const nodeId = await makeNode("rollup-r");
    await seed(nodeId, new Date(Date.now() - 30 * 3_600_000)); // beyond 24h raw retention
    await seed(nodeId, new Date(Date.now() - 1 * 3_600_000)); // kept
    await h.db.insert(snapshotBuckets).values([
      { nodeId, granularity: "minute", bucketStart: new Date(Date.now() - 8 * 86_400_000), samples: 1 },
      { nodeId, granularity: "minute", bucketStart: new Date(Date.now() - 2 * 3_600_000), samples: 1 },
      { nodeId, granularity: "hour", bucketStart: new Date(Date.now() - 100 * 86_400_000), samples: 1 },
      { nodeId, granularity: "hour", bucketStart: new Date(Date.now() - 2 * 3_600_000), samples: 1 },
      { nodeId, granularity: "day", bucketStart: new Date(Date.now() - 400 * 86_400_000), samples: 1 },
      { nodeId, granularity: "day", bucketStart: new Date(Date.now() - 2 * 86_400_000), samples: 1 },
    ]);

    const result = await runRetention(store, h.db, {
      rawHours: 24,
      minuteKeepDays: 7,
      hourKeepDays: 90,
      dayKeepDays: 365,
    });

    const raws = await h.db.select().from(snapshots).where(eq(snapshots.nodeId, nodeId));
    expect(raws).toHaveLength(1);
    expect(raws[0]!.serverTime.getTime()).toBeGreaterThan(Date.now() - 2 * 3_600_000);
    expect(await bucketsFor("minute", nodeId)).toHaveLength(1);
    expect((await bucketsFor("minute", nodeId))[0]!.bucketStart.getTime()).toBeGreaterThan(Date.now() - 3 * 3_600_000);
    expect(await bucketsFor("hour", nodeId)).toHaveLength(1);
    expect((await bucketsFor("hour", nodeId))[0]!.bucketStart.getTime()).toBeGreaterThan(Date.now() - 3 * 3_600_000);
    expect((await bucketsFor("day", nodeId))).toHaveLength(1);
    expect((await bucketsFor("day", nodeId))[0]!.bucketStart.getTime()).toBeGreaterThan(Date.now() - 3 * 86_400_000);
    expect(result.raw).toBeGreaterThanOrEqual(1); // other tests' aged raws go too
    expect(result.minute).toBeGreaterThanOrEqual(1);
    expect(result.hour).toBeGreaterThanOrEqual(1);
    expect(result.day).toBeGreaterThanOrEqual(1);
  });

  it("serves history from seeded buckets with the contracted point shape", async () => {
    const nodeId = await makeNode("history-h");
    const t1 = new Date(Date.now() - 10 * 60_000);
    const t2 = new Date(Date.now() - 5 * 60_000);
    await h.db.insert(snapshotBuckets).values([
      {
        nodeId,
        granularity: "minute",
        bucketStart: t1,
        samples: 5,
        cpuUsagePct: 11,
        cpuTempC: 50,
        cpuTempMinC: 40,
        cpuTempMaxC: 60,
        gpuUsagePct: 33,
        gpuTempC: 55,
        gpuTempMinC: 50,
        gpuTempMaxC: 60,
        gpuPowerW: 100,
        gpuMemUsedBytes: 3e9,
        memUsedBytes: 60e9,
        netRxBps: 1000,
        netTxBps: 500,
      },
      { nodeId, granularity: "minute", bucketStart: t2, samples: 3, cpuUsagePct: 22 },
    ]);

    const app = makeApiApp();
    const res = await request(app).get(`/api/v1/nodes/${nodeId}/history`).query({ range: "1h" });
    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe("minute");
    expect(res.body.points).toHaveLength(2);
    expect(res.body.points[0].t).toBe(t1.getTime());
    expect(res.body.points[0].cpu).toBeCloseTo(11);
    expect(res.body.points[0].cpuTemp).toEqual({ min: 40, avg: 50, max: 60 });
    expect(res.body.points[0].mem).toBeCloseTo(60e9);
    expect(res.body.points[0].gpu).toBeCloseTo(33);
    expect(res.body.points[0].gpuTemp).toEqual({ min: 50, avg: 55, max: 60 });
    expect(res.body.points[0].gpuPowerW).toBeCloseTo(100);
    expect(res.body.points[0].gpuMem).toBeCloseTo(3e9);
    expect(res.body.points[0].netRx).toBeCloseTo(1000);
    expect(res.body.points[0].netTx).toBeCloseTo(500);
    expect(res.body.points[0].samples).toBe(5);
    expect(res.body.points[1].t).toBe(t2.getTime());
    expect(res.body.points[1].cpu).toBeCloseTo(22);
    expect(res.body.points[1].samples).toBe(3);

    // 24h → hour buckets, 90d → day buckets.
    await h.db.insert(snapshotBuckets).values({
      nodeId,
      granularity: "hour",
      bucketStart: new Date(Date.now() - 2 * 3_600_000),
      samples: 60,
      cpuUsagePct: 7,
    });
    const res24 = await request(app).get(`/api/v1/nodes/${nodeId}/history`).query({ range: "24h" });
    expect(res24.status).toBe(200);
    expect(res24.body.granularity).toBe("hour");
    expect(res24.body.points).toHaveLength(1);
    expect(res24.body.points[0].cpu).toBeCloseTo(7);

    await h.db.insert(snapshotBuckets).values({
      nodeId,
      granularity: "day",
      bucketStart: new Date(Date.now() - 86_400_000),
      samples: 1440,
      gpuUsagePct: 5,
    });
    const res90 = await request(app).get(`/api/v1/nodes/${nodeId}/history`).query({ range: "90d" });
    expect(res90.status).toBe(200);
    expect(res90.body.granularity).toBe("day");
    expect(res90.body.points).toHaveLength(1);
    expect(res90.body.points[0].gpu).toBeCloseTo(5);
  });

  it("falls back to raw snapshots for 1h when minute buckets are absent", async () => {
    const nodeId = await makeNode("history-f");
    await h.db.insert(snapshots).values([
      {
        nodeId,
        serverTime: new Date(Date.now() - 90_000),
        payload: makeSnapshot({
          cpu: { model: "GB10 SoC", cores: 20, usagePct: 10, tempC: 40, packagePowerW: null },
          network: [{ iface: "eth0", rxBps: 1000, txBps: 500 }],
        }),
      },
      {
        nodeId,
        serverTime: new Date(Date.now() - 30_000),
        payload: makeSnapshot({
          cpu: { model: "GB10 SoC", cores: 20, usagePct: 30, tempC: 60, packagePowerW: null },
          network: [{ iface: "eth0", rxBps: 3000, txBps: 1500 }],
        }),
      },
    ]);

    const app = makeApiApp();
    const res = await request(app).get(`/api/v1/nodes/${nodeId}/history`).query({ range: "1h" });
    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe("minute");
    expect(res.body.points).toHaveLength(2); // 60s apart → always distinct minutes
    expect(res.body.points[0].t).toBeLessThan(res.body.points[1].t);
    expect(res.body.points[0].cpu).toBeCloseTo(10);
    expect(res.body.points[0].samples).toBe(1);
    expect(res.body.points[1].cpu).toBeCloseTo(30);
    expect(res.body.points[1].netRx).toBeCloseTo(3000);

    // Non-minute granularities never fall back to raw.
    const res7d = await request(app).get(`/api/v1/nodes/${nodeId}/history`).query({ range: "7d" });
    expect(res7d.status).toBe(200);
    expect(res7d.body.granularity).toBe("hour");
    expect(res7d.body.points).toEqual([]);
  });
});
