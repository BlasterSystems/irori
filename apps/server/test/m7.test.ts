import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createDbHandle, llmBuckets, llmSnapshots, nodes, snapshotBuckets, tokenLedger, cleanupRuns, jobs as jobsTable } from "@irori/db";
import type { Db } from "@irori/db";
import { pickStoreNode } from "@irori/core";
import { createTokenLedgerEngine, pruneTokenLedger } from "../src/ledger.js";
import { createEnergyEngine } from "../src/energy.js";
import { createAnalyticsService } from "../src/analytics.js";
import { createJobsService } from "../src/jobs-service.js";
import { createCleanupService } from "../src/cleanup-service.js";

/**
 * M7 integration: token ledger deltas, analytics folding, energy archive and
 * the cleanup-run lifecycle. Requires a REAL Postgres — same convention as
 * bench.test.ts (IRORI_TEST_DATABASE_URL at a DISPOSABLE database; CI starts
 * a Postgres service container).
 */
const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("M7 ledger + analytics + cleanup (db integration)", () => {
  let handle: ReturnType<typeof createDbHandle>;
  let db: Db;
  let nodeId: string;
  let sent: Array<{ nodeId: string; msg: unknown }>;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.insert(nodes).values({
      id: nodeId,
      name: `m7-test-${nodeId.slice(0, 8)}`,
      kind: "spark",
      role: "standalone",
      host: "localhost",
      agentTokenHash: "x",
      agentTokenEnc: "x",
    });
    sent = [];
  });

  afterAll(async () => {
    await db.delete(nodes).where(eq(nodes.id, nodeId));
    await handle.close();
  });

  const llmSnapshot = (counters: { g: number | null; p: number | null; c: number | null }, minutesAgo: number) => ({
    nodeId,
    serverTime: new Date(Date.now() - minutesAgo * 60_000),
    payload: {
      ports: [
        {
          port: 8080,
          host: "127.0.0.1",
          backend: "vllm",
          detected: true,
          model: "test-model",
          tokens: { generated: counters.g, prompt: counters.p, cached: counters.c },
          probedAtMs: 0,
        },
      ],
    },
  });

  it("diffs cumulative counters into minute/hourly/daily ledger rows and survives re-runs", async () => {
    await db.insert(llmSnapshots).values([
      llmSnapshot({ g: 100, p: 1000, c: 40 }, 50),
      llmSnapshot({ g: 300, p: 2000, c: 90 }, 40),
      // engine restart: counter went DOWN — re-baseline, no negative tokens
      llmSnapshot({ g: 10, p: 20, c: 0 }, 30),
      llmSnapshot({ g: 60, p: 120, c: 5 }, 20),
    ]);
    const engine = createTokenLedgerEngine(db);
    await engine.runOnce();
    await engine.runOnce(); // idempotent: no double counting

    const rows = await db.select().from(tokenLedger).where(eq(tokenLedger.nodeId, nodeId));
    const hourly = rows.filter((r) => r.granularity === "hour");
    // The seeded snapshots span one or two hour buckets depending on when the
    // suite runs (top-of-hour boundary) — the sums must hold across them all.
    const genSum = hourly.reduce((s, r) => s + r.generatedTokens, 0);
    const promptSum = hourly.reduce((s, r) => s + r.promptTokens, 0);
    const cachedSum = hourly.reduce((s, r) => s + r.cachedTokens, 0);
    expect(genSum).toBe(250);
    expect(promptSum).toBe(1100);
    expect(cachedSum).toBe(55);
    expect(hourly).toHaveLength(new Set(hourly.map((r) => r.bucketStart.toISOString())).size);
    expect(hourly[0]!.model).toBe("test-model");
    expect(rows.filter((r) => r.granularity === "day").length).toBeLessThanOrEqual(2);
    // Minute rows mirror the same deltas (feeds the 30m/4h token views).
    const minuteRows = rows.filter((r) => r.granularity === "minute");
    expect(minuteRows.length).toBeGreaterThanOrEqual(hourly.length);
    expect(minuteRows.reduce((s, r) => s + r.generatedTokens, 0)).toBe(250);
    expect(minuteRows.reduce((s, r) => s + r.promptTokens, 0)).toBe(1100);
  });

  it("diffs tensorfold and exl3 probe counters into ledger rows (IR-153)", async () => {
    // Same payload shape the agent probe now emits for these backends:
    // tensorfold publishes cached, exl3 publishes null there.
    const snap = (port: number, tokens: { generated: number | null; prompt: number | null; cached: number | null }, model: string, minutesAgo: number) => ({
      nodeId,
      serverTime: new Date(Date.now() - minutesAgo * 60_000),
      payload: {
        ports: [{ port, host: "127.0.0.1", backend: port === 8123 ? "tensorfold" : "exl3", detected: true, model, tokens, probedAtMs: 0 }],
      },
    });
    await db.insert(llmSnapshots).values([
      snap(8123, { generated: 500, prompt: 12000, cached: 7000 }, "tf-model", 12),
      snap(8123, { generated: 540, prompt: 12500, cached: 7100 }, "tf-model", 10),
      snap(8124, { generated: 90, prompt: 180, cached: null }, "exl3-model", 12),
      snap(8124, { generated: 99, prompt: 230, cached: null }, "exl3-model", 10),
    ]);
    const engine = createTokenLedgerEngine(db);
    await engine.runOnce();

    const rows = (await db.select().from(tokenLedger).where(eq(tokenLedger.nodeId, nodeId))).filter((r) => r.port === 8123 || r.port === 8124);
    const tf = rows.filter((r) => r.port === 8123 && r.granularity === "hour");
    const ex = rows.filter((r) => r.port === 8124 && r.granularity === "hour");
    expect(tf.reduce((s, r) => s + r.generatedTokens, 0)).toBe(40);
    expect(tf.reduce((s, r) => s + r.promptTokens, 0)).toBe(500);
    expect(tf.reduce((s, r) => s + r.cachedTokens, 0)).toBe(100);
    expect(tf[0]!.model).toBe("tf-model");
    expect(ex.reduce((s, r) => s + r.generatedTokens, 0)).toBe(9);
    expect(ex.reduce((s, r) => s + r.promptTokens, 0)).toBe(50);
    expect(ex.reduce((s, r) => s + r.cachedTokens, 0)).toBe(0);
    expect(ex.every((r) => !r.cachedSeen)).toBe(true); // null counter → coverage, never a zero guess
  });

  it("prunes ledger rows past retention", async () => {
    await db.insert(tokenLedger).values({
      nodeId,
      port: 9999,
      model: "old",
      granularity: "day",
      bucketStart: new Date(Date.now() - 400 * 86_400_000),
      generatedTokens: 1,
      promptSeen: true,
      promptTokens: 1,
    });
    await pruneTokenLedger(db, 7, 90, 365);
    const old = await db.select().from(tokenLedger).where(and(eq(tokenLedger.nodeId, nodeId), eq(tokenLedger.model, "old")));
    expect(old).toHaveLength(0);
  });

  it("folds per-node buckets into node and cluster series with lens semantics", async () => {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3_600_000);
    await db.insert(snapshotBuckets).values([
      { nodeId, granularity: "hour", bucketStart: hourAgo, samples: 3, gpuTempC: 60, gpuTempMinC: 55, gpuTempMaxC: 66, cpuTempC: 57, cpuTempMinC: 50, cpuTempMaxC: 60, gpuPowerW: 80, packagePowerW: 30, memUsedBytes: 10e9, memTotalBytes: 100e9, gpuThrottled: true },
    ]);
    await db.insert(llmBuckets).values([
      { nodeId, port: 8080, granularity: "hour", bucketStart: hourAgo, samples: 3, decodeTps: 100, prefillTps: 500 },
      { nodeId, port: 8081, granularity: "hour", bucketStart: hourAgo, samples: 3, decodeTps: 40, prefillTps: null },
    ]);

    const service = createAnalyticsService(db);
    const temps = await service.build({ lens: "temps", range: "24h", groupBy: "node" });
    expect(temps.series).toHaveLength(1);
    expect(temps.series[0]!.points[0]).toMatchObject({ gpuMin: 55, gpuMax: 66, cpuMin: 50, cpuMax: 60, throttled: true });

    const power = await service.build({ lens: "power", range: "24h", groupBy: "node" });
    expect(power.series[0]!.points[0]).toMatchObject({ watts: 150, gpuW: 80, cpuW: 30, baseW: 40, coverage: 1 });

    const decode = await service.build({ lens: "decode", range: "24h", groupBy: "node" });
    // Ports add up on one node (two engines serving different models).
    expect(decode.series[0]!.points[0]).toMatchObject({ decodeTps: 140, prefillTps: 500 });

    // Cluster grouping: our node has no setup, so it folds into "standalone"
    // (other suites' setups appear as their own series in the shared DB).
    const cluster = await service.build({ lens: "temps", range: "24h", groupBy: "cluster" });
    const standalone = cluster.series.find((s) => s.key === "standalone");
    expect(standalone).toBeDefined();
    expect(standalone!.points[0]).toMatchObject({ gpuMax: 66, throttled: true });
  });

  it("persists the hygiene report from the job's final output line", async () => {
    const jobs = createJobsService(db, (id, msg) => {
      sent.push({ nodeId: id, msg });
      return true;
    });
    const job = await jobs.create(nodeId, "hygiene-audit", {});
    // Agent streams lines; the LAST line is the JSON report.
    await jobs.onOutput(nodeId, job.id, 0, "$ docker system df");
    await jobs.onOutput(nodeId, job.id, 1, JSON.stringify({ generatedAtMs: 1, totalBytes: 100, freeBytes: 10, categories: [{ category: "docker-build-cache", safe: true, rationale: "rebuildable", itemCount: 1, reclaimableBytes: 5 }] }));
    await jobs.onDone(nodeId, job.id, "succeeded", 0);

    const [run] = await db.select().from(cleanupRuns).where(eq(cleanupRuns.jobId, job.id));
    expect(run).toBeDefined();
    expect(run!.status).toBe("succeeded");
    expect(run!.kind).toBe("audit");
    const report = run!.report as { categories: Array<{ category: string }> };
    expect(report.categories[0]!.category).toBe("docker-build-cache");

    // Cancel path (IR-131): the request is marked but the run stays running —
    // the cleanup run settles only when the agent's terminal report lands.
    const job2 = await jobs.create(nodeId, "hygiene-clean", { categories: ["docker-build-cache"], dryRun: false });
    await jobs.cancel(job2.id);
    const [pendingRow] = await db.select().from(jobsTable).where(eq(jobsTable.id, job2.id));
    expect(pendingRow!.status).toBe("running");
    expect(pendingRow!.cancelRequestedAt).not.toBeNull();
    const [run2] = await db.select().from(cleanupRuns).where(eq(cleanupRuns.jobId, job2.id));
    expect(run2!.status).toBe("running");
    await jobs.onDone(nodeId, job2.id, "canceled", null);
    const [run3] = await db.select().from(cleanupRuns).where(eq(cleanupRuns.jobId, job2.id));
    expect(run3!.status).toBe("canceled");
  });

  it("archives monthly energy clamped to the GB10 envelope", async () => {
    // Hermetic: drop this node's buckets + archive (shared DB, parallel suites).
    await db.delete(snapshotBuckets).where(eq(snapshotBuckets.nodeId, nodeId));
    await db.execute(`delete from energy_monthly where node_id = '${nodeId}'`);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 5));
    await db.insert(snapshotBuckets).values([
      { nodeId, granularity: "hour", bucketStart: monthStart, samples: 2, gpuPowerW: 150, packagePowerW: 60 }, // 250 → clamped 240
      { nodeId, granularity: "hour", bucketStart: new Date(monthStart.getTime() + 3_600_000), samples: 2, gpuPowerW: 150, packagePowerW: 90 }, // 280 → clamped 240
    ]);
    await createEnergyEngine(db).runOnce();
    const res = await db.execute<{ total_wh: number }>(`
      select total_wh from energy_monthly where node_id = '${nodeId}'
    `);
    const rows = res as unknown as Array<{ total_wh: number }>;
    expect(rows[0]!.total_wh).toBe(240 + 240); // clamped per bucket before integration
  });

  it("scopes the modelctl-staging audit category to the store node (IRI-047)", async () => {
    // The disposable DB is shared by parallel suites, which may hold their own
    // kind:"nas" rows — expectations follow the SAME pickStoreNode answer the
    // service reads, so whichever NAS node resolves, both branches hold.
    const nasId = randomUUID();
    await db.insert(nodes).values({
      id: nasId,
      name: `m7-nas-${nasId.slice(0, 8)}`,
      kind: "nas",
      role: "standalone",
      host: "nas",
      agentTokenHash: "x",
      agentTokenEnc: "x",
      nasRoot: "/mnt/store",
    });
    const auditReport = {
      generatedAtMs: 1,
      totalBytes: 1000,
      freeBytes: 100,
      categories: [
        { category: "docker-build-cache", safe: true, rationale: "rebuildable", itemCount: 1, reclaimableBytes: 5 },
        { category: "modelctl-staging", safe: false, rationale: "store staging", itemCount: 1, reclaimableBytes: 253_397_553_152 },
      ],
    };
    await db.insert(cleanupRuns).values([
      { nodeId, kind: "audit", status: "succeeded", report: auditReport },
      { nodeId: nasId, kind: "audit", status: "succeeded", report: auditReport },
      // Clean rows keep their requested categories (factual history).
      { nodeId, kind: "clean", status: "succeeded", categories: ["modelctl-staging"], report: { startedAtMs: 1, finishedAtMs: 2, dryRun: false, outcomes: [] } },
    ]);
    const cleanup = createCleanupService(db);
    const store = pickStoreNode(await db.select().from(nodes))!.id;

    const categoriesOf = async (id: string): Promise<string[]> => {
      const entry = await cleanup.latestAudit(id);
      // Test-seam cast: the stored jsonb shape is pinned by the pure suite.
      const report = entry!.report as { categories: Array<{ category: string }> } | null;
      return (report?.categories ?? []).map((c) => c.category);
    };
    // The spark node under test never carries the store root — staging stripped.
    expect(await categoriesOf(nodeId)).toEqual(["docker-build-cache"]);
    // The NAS row keeps staging iff it is the resolved store node.
    const nasCats = await categoriesOf(nasId);
    if (nasId === store) expect(nasCats).toContain("modelctl-staging");
    else expect(nasCats).toEqual(["docker-build-cache"]);

    // History audit rows are scoped the same way; clean rows stay factual.
    const history = await cleanup.history(nodeId);
    for (const row of history.filter((r) => r.kind === "audit")) {
      const report = row.report as { categories?: Array<{ category: string }> } | null;
      expect((report?.categories ?? []).map((c) => c.category)).not.toContain("modelctl-staging");
    }
    expect(history.find((r) => r.kind === "clean")!.categories).toEqual(["modelctl-staging"]);

    // Scoped cleanup: this suite's jobId-less rows + the NAS node (cascades).
    await db.delete(cleanupRuns).where(and(eq(cleanupRuns.nodeId, nasId), isNull(cleanupRuns.jobId)));
    await db.delete(nodes).where(eq(nodes.id, nasId));
    await db.delete(cleanupRuns).where(and(eq(cleanupRuns.nodeId, nodeId), isNull(cleanupRuns.jobId)));
  });
});
