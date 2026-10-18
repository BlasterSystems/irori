import { and, asc, eq, gte, sql, type SQL } from "drizzle-orm";
import { snapshotBuckets } from "@irori/db";
import type { Db } from "@irori/db";
import { aggregateCols, bucketStartExpr, perSnapshotCte, type Granularity } from "./rollups.js";

export const HISTORY_RANGES = ["1h", "24h", "7d", "30d", "90d"] as const;

export type HistoryRange = (typeof HISTORY_RANGES)[number];

export function isHistoryRange(value: string): value is HistoryRange {
  return (HISTORY_RANGES as readonly string[]).includes(value);
}

export const RANGE_MS: Record<HistoryRange, number> = {
  "1h": 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
};

/** 1h resolves to raw-resolution minutes; 24h/7d/30d to hours; 90d to days. */
export const RANGE_GRANULARITY: Record<HistoryRange, Granularity> = {
  "1h": "minute",
  "24h": "hour",
  "7d": "hour",
  "30d": "hour",
  "90d": "day",
};

/** Pure granularity selection per range (unit-tested without a database). */
export function historyGranularity(range: HistoryRange): Granularity {
  return RANGE_GRANULARITY[range];
}

export interface HistoryPoint {
  /** Bucket start, epoch ms UTC. */
  t: number;
  cpu: number | null;
  cpuTemp: { min: number | null; avg: number | null; max: number | null };
  /** Avg used bytes across the bucket. */
  mem: number | null;
  gpu: number | null;
  gpuTemp: { min: number | null; avg: number | null; max: number | null };
  gpuPowerW: number | null;
  /** Avg summed-across-cards GPU used bytes. */
  gpuMem: number | null;
  netRx: number | null;
  netTx: number | null;
  samples: number;
}

export interface HistoryResponse {
  granularity: Granularity;
  points: HistoryPoint[];
}

export async function buildHistory(
  db: Db,
  nodeId: string,
  range: HistoryRange,
  now = new Date(),
): Promise<HistoryResponse> {
  const granularity = RANGE_GRANULARITY[range];
  const since = new Date(now.getTime() - RANGE_MS[range]);
  const rows = await db
    .select()
    .from(snapshotBuckets)
    .where(
      and(
        eq(snapshotBuckets.nodeId, nodeId),
        eq(snapshotBuckets.granularity, granularity),
        gte(snapshotBuckets.bucketStart, since),
      ),
    )
    .orderBy(asc(snapshotBuckets.bucketStart));

  let points = rows.map((row) => ({
    t: row.bucketStart.getTime(),
    cpu: row.cpuUsagePct,
    cpuTemp: { min: row.cpuTempMinC, avg: row.cpuTempC, max: row.cpuTempMaxC },
    mem: row.memUsedBytes,
    gpu: row.gpuUsagePct,
    gpuTemp: { min: row.gpuTempMinC, avg: row.gpuTempC, max: row.gpuTempMaxC },
    gpuPowerW: row.gpuPowerW,
    gpuMem: row.gpuMemUsedBytes,
    netRx: row.netRxBps,
    netTx: row.netTxBps,
    samples: row.samples,
  }));

  // Recent deploy: minute buckets may not exist yet — fall back to raw
  // snapshots for the 1h window so the chart is never empty.
  if (points.length === 0 && granularity === "minute") {
    points = await minuteBucketsFromRaw(db, nodeId, since, now);
  }

  return { granularity, points };
}

/** Aggregates raw snapshots into one-off minute buckets (same math as the engine). */
async function minuteBucketsFromRaw(db: Db, nodeId: string, since: Date, until: Date): Promise<HistoryPoint[]> {
  const bucketStart = bucketStartExpr("minute");
  const rows = await db.execute<{
    t: number;
    samples: number;
    cpu_usage_pct: number | null;
    cpu_temp_avg: number | null;
    cpu_temp_min: number | null;
    cpu_temp_max: number | null;
    mem_used_bytes: number | null;
    gpu_usage_pct: number | null;
    gpu_temp_avg: number | null;
    gpu_temp_min: number | null;
    gpu_temp_max: number | null;
    gpu_power_w: number | null;
    gpu_mem_used_bytes: number | null;
    net_rx_bps: number | null;
    net_tx_bps: number | null;
  }>(sql`
    ${perSnapshotCte(since, until, nodeId)}
    select
      (extract(epoch from ${bucketStart}) * 1000)::float8 as t,
      ${aggregateCols()}
    from per_snapshot
    group by node_id, ${bucketStart}
    order by 1
  `);
  return rows.map((row) => ({
    t: row.t,
    cpu: row.cpu_usage_pct,
    cpuTemp: { min: row.cpu_temp_min, avg: row.cpu_temp_avg, max: row.cpu_temp_max },
    mem: row.mem_used_bytes,
    gpu: row.gpu_usage_pct,
    gpuTemp: { min: row.gpu_temp_min, avg: row.gpu_temp_avg, max: row.gpu_temp_max },
    gpuPowerW: row.gpu_power_w,
    gpuMem: row.gpu_mem_used_bytes,
    netRx: row.net_rx_bps,
    netTx: row.net_tx_bps,
    samples: row.samples,
  }));
}
