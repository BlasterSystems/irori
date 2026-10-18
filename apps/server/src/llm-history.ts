import { and, asc, eq, gte, sql } from "drizzle-orm";
import { llmBuckets } from "@irori/db";
import type { Db } from "@irori/db";
import { bucketStartExpr, type Granularity } from "./rollups.js";
import { perPortCte } from "./llm-rollups.js";
import { historyGranularity, RANGE_MS, type HistoryRange } from "./history.js";

export interface LlmHistoryPoint {
  /** Bucket start, epoch ms UTC. */
  t: number;
  decodeTps: number | null;
  prefillTps: number | null;
  queueRunning: number | null;
  queueWaiting: number | null;
  kvCachePct: number | null;
  ttftP95Ms: number | null;
  samples: number;
}

export interface LlmPortSeries {
  port: number;
  points: LlmHistoryPoint[];
}

export interface LlmHistoryResponse {
  granularity: Granularity;
  series: LlmPortSeries[];
}

/**
 * Per-port LLM history: bucket rows grouped into ascending per-port series.
 * When no buckets exist for the 1h window (fresh deploy), falls back to
 * raw llm snapshots aggregated into one-off minute buckets.
 */
export async function buildLlmHistory(
  db: Db,
  nodeId: string,
  range: HistoryRange,
  now = new Date(),
): Promise<LlmHistoryResponse> {
  const granularity = historyGranularity(range);
  const since = new Date(now.getTime() - RANGE_MS[range]);
  const rows = await db
    .select()
    .from(llmBuckets)
    .where(
      and(
        eq(llmBuckets.nodeId, nodeId),
        eq(llmBuckets.granularity, granularity),
        gte(llmBuckets.bucketStart, since),
      ),
    )
    .orderBy(asc(llmBuckets.port), asc(llmBuckets.bucketStart));

  if (rows.length === 0 && granularity === "minute") {
    return { granularity, series: await minuteSeriesFromRaw(db, nodeId, since, now) };
  }

  return { granularity, series: seriesFromBucketRows(rows) };
}

/**
 * Groups (port, bucketStart-ordered) bucket rows into contiguous per-port
 * series. Rows arrive sorted by (port, bucket_start), so a port change
 * starts a new series. Pure — unit-tested without a database.
 */
export function seriesFromBucketRows(
  rows: Array<{ port: number; bucketStart: Date } & Omit<LlmHistoryPoint, "t">>,
): LlmPortSeries[] {
  const series: LlmPortSeries[] = [];
  for (const row of rows) {
    const point: LlmHistoryPoint = {
      t: row.bucketStart.getTime(),
      decodeTps: row.decodeTps,
      prefillTps: row.prefillTps,
      queueRunning: row.queueRunning,
      queueWaiting: row.queueWaiting,
      kvCachePct: row.kvCachePct,
      ttftP95Ms: row.ttftP95Ms,
      samples: row.samples,
    };
    const last = series[series.length - 1];
    if (last === undefined || last.port !== row.port) {
      series.push({ port: row.port, points: [point] });
    } else {
      last.points.push(point);
    }
  }
  return series;
}

/** Aggregates raw llm snapshots into one-off minute buckets (same math as the engine). */
async function minuteSeriesFromRaw(
  db: Db,
  nodeId: string,
  since: Date,
  until: Date,
): Promise<LlmPortSeries[]> {
  const bucketStart = bucketStartExpr("minute");
  const rows = await db.execute<{
    port: number;
    t: number;
    samples: number;
    decode_tps: number | null;
    prefill_tps: number | null;
    queue_running: number | null;
    queue_waiting: number | null;
    kv_cache_pct: number | null;
    ttft_p95_ms: number | null;
  }>(sql`
    ${perPortCte(since, until, nodeId)}
    select
      (extract(epoch from ${bucketStart}) * 1000)::float8 as t,
      port,
      count(*)::int as samples,
      avg(decode_tps)::float8 as decode_tps,
      avg(prefill_tps)::float8 as prefill_tps,
      avg(queue_running)::float8 as queue_running,
      avg(queue_waiting)::float8 as queue_waiting,
      avg(kv_cache_pct)::float8 as kv_cache_pct,
      avg(ttft_p95_ms)::float8 as ttft_p95_ms
    from per_port
    group by node_id, port, ${bucketStart}
    order by port, 1
  `);
  return seriesFromBucketRows(
    rows.map((row) => ({
      port: row.port,
      bucketStart: new Date(row.t),
      decodeTps: row.decode_tps,
      prefillTps: row.prefill_tps,
      queueRunning: row.queue_running,
      queueWaiting: row.queue_waiting,
      kvCachePct: row.kv_cache_pct,
      ttftP95Ms: row.ttft_p95_ms,
      samples: row.samples,
    })),
  );
}
