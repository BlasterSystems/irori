import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbHandle, nodes, snapshotBuckets, tokenLedger, type Db, type DbHandle } from "@irori/db";
import { createAnalyticsService } from "../src/analytics.js";

/**
 * IRI-073 (IR-164): Wh-per-token efficiency — paired fixtures (known watts ×
 * known tokens → exact whPerKToken), missing coverage → null + reason (never
 * zero), NAS excluded from energy.
 */

const url = process.env.IRORI_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("efficiency (db integration)", () => {
  let handle: DbHandle;
  let db: Db;
  let nodeId: string;

  beforeAll(async () => {
    handle = createDbHandle(url!);
    await handle.migrate();
    db = handle.db;
    nodeId = randomUUID();
    await db.delete(snapshotBuckets);
    await db.delete(tokenLedger);
    await db.delete(nodes);
    await db.insert(nodes).values([
      { id: nodeId, name: "spark1", kind: "spark", role: "standalone", host: "localhost", agentTokenHash: "x", agentTokenEnc: "x" },
    ]);
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    // Two buckets @ 100 W GPU + 20 W CPU + 40 W base = 160 W clamped (envelope 240)
    // → 160 Wh per bucket; two buckets with readings = 320 Wh total.
    await db.insert(snapshotBuckets).values([
      { nodeId, granularity: "hour", bucketStart: hour, samples: 1, gpuPowerW: 100, packagePowerW: 20 },
      { nodeId, granularity: "hour", bucketStart: new Date(hour.getTime() + 3_600_000), samples: 1, gpuPowerW: 100, packagePowerW: 20 },
      { nodeId, granularity: "hour", bucketStart: new Date(hour.getTime() + 2 * 3_600_000), samples: 0 }, // no reading
    ]);
    await db.insert(tokenLedger).values([
      { nodeId, port: 8081, model: "glm", granularity: "hour", bucketStart: hour, generatedTokens: 60_000, promptTokens: 40_000, generatedSeen: true, promptSeen: true },
    ]);
  });

  afterAll(async () => {
    await db.delete(nodes);
    await handle.close();
  });

  it("computes exact whPerKToken from paired fixtures", async () => {
    const service = createAnalyticsService(db);
    const res = await service.efficiency({ range: "24h", groupBy: "node" });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.label).toBe("spark1");
    expect(row.energyWh).toBe(320); // 2 buckets × 160 W × 1 h
    expect(row.tokens).toBe(100_000);
    expect(row.whPerKToken).toBe(3.2); // 320 Wh / 100 ktok
    expect(row.reason).toBeNull();
    // Coverage: 2 of 3 buckets carried a reading.
    expect(row.energyCoverage).toBeCloseTo(2 / 3, 2);
  });

  it("returns null + reason when tokens are missing (never zero)", async () => {
    const service = createAnalyticsService(db);
    await db.delete(tokenLedger);
    const res = await service.efficiency({ range: "24h", groupBy: "node" });
    expect(res.rows[0]!.whPerKToken).toBeNull();
    expect(res.rows[0]!.reason).toBe("no token counters in range");
    expect(res.rows[0]!.energyWh).toBe(320);
  });

  it("excludes the NAS from energy entirely", async () => {
    const nasId = randomUUID();
    await db.insert(nodes).values({ id: nasId, name: "nas", kind: "nas", role: "standalone", host: "localhost", agentTokenHash: "x", agentTokenEnc: "x" });
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await db.insert(snapshotBuckets).values({ nodeId: nasId, granularity: "hour", bucketStart: hour, samples: 1, packagePowerW: 30 });
    const service = createAnalyticsService(db);
    const res = await service.efficiency({ range: "24h", groupBy: "node" });
    expect(res.rows.find((r) => r.label === "nas")).toBeUndefined();
    const spark = res.rows.find((r) => r.label === "spark1")!;
    expect(spark.energyWh).toBe(320); // unchanged by the NAS bucket
    await db.delete(nodes).where(eq(nodes.id, nasId));
  });
});

import { eq } from "drizzle-orm";
