import { asc, sql, type SQL } from "drizzle-orm";
import { llmSnapshots } from "@irori/db";
import type { Db } from "@irori/db";
import {
  floorTo,
  granularityLiteral,
  GRANULARITIES,
  readWatermark,
  writeWatermark,
  bucketStartExpr,
  type Granularity,
} from "./rollups.js";

/**
 * LLM probe rollups — mirrors rollups.ts (IRI-003 §5, ADR-0006) with two
 * differences: each snapshot's `ports` array is unfolded to (node, port)
 * rows via jsonb_array_elements, and the watermark lives under its own
 * settings key so the hardware and LLM pipelines advance independently.
 * Buckets are keyed by SERVER receive time; averages skip nulls so
 * undetected metrics never skew a bucket.
 */
export const LLM_ROLLUP_WATERMARK_KEY = "llm_rollup_watermark";

/**
 * Per-snapshot projection: each `ports[]` entry becomes one row. Snapshots
 * whose payload has no ports array produce no rows; a malformed (non-array)
 * ports value is treated as empty instead of erroring the whole pass.
 */
export function perPortCte(fromTs: Date, toTs: Date, nodeId?: string): SQL {
  return sql`
    with per_port as (
      select
        s.node_id,
        s.server_time,
        (p->>'port')::int as port,
        (p->>'decodeTps')::float8 as decode_tps,
        (p->>'prefillTps')::float8 as prefill_tps,
        (p->>'queueRunning')::float8 as queue_running,
        (p->>'queueWaiting')::float8 as queue_waiting,
        (p->>'kvCachePct')::float8 as kv_cache_pct,
        (p->>'ttftP95Ms')::float8 as ttft_p95_ms
      from llm_snapshots s
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(s.payload->'ports') = 'array' then s.payload->'ports' else '[]'::jsonb end
      ) p
      where s.server_time >= ${fromTs.toISOString()} and s.server_time < ${toTs.toISOString()}
      ${nodeId === undefined ? sql`` : sql`and s.node_id = ${nodeId}`}
    )
  `;
}

/**
 * Aggregates raw llm snapshots into `granularity` buckets for every bucket
 * start in [fromTs, toTs), upserted per (node_id, port). `samples` counts
 * merged port rows. Returns the number of buckets written. Empty ranges are
 * a no-op. Safe to run every 60s.
 */
export async function computeLlmBuckets(
  db: Db,
  granularity: Granularity,
  fromTs: Date,
  toTs: Date,
): Promise<number> {
  if (fromTs.getTime() >= toTs.getTime()) return 0;
  const bucketStart = bucketStartExpr(granularity);
  const result = await db.execute(sql`
    ${perPortCte(fromTs, toTs)}
    insert into llm_buckets
      (node_id, port, granularity, bucket_start, samples, decode_tps, prefill_tps, queue_running, queue_waiting, kv_cache_pct, ttft_p95_ms)
    select
      node_id,
      port,
      ${granularityLiteral(granularity)},
      ${bucketStart},
      count(*)::int as samples,
      avg(decode_tps)::float8,
      avg(prefill_tps)::float8,
      avg(queue_running)::real,
      avg(queue_waiting)::real,
      avg(kv_cache_pct)::real,
      avg(ttft_p95_ms)::real
    from per_port
    group by node_id, port, ${bucketStart}
    on conflict (node_id, port, granularity, bucket_start) do update set
      samples = excluded.samples,
      decode_tps = excluded.decode_tps,
      prefill_tps = excluded.prefill_tps,
      queue_running = excluded.queue_running,
      queue_waiting = excluded.queue_waiting,
      kv_cache_pct = excluded.kv_cache_pct,
      ttft_p95_ms = excluded.ttft_p95_ms
    returning node_id
  `);
  return result.length;
}

export interface LlmRollupEngine {
  /**
   * Processes every complete bucket since the llm watermark, then advances
   * it. `now` is injectable for tests. No-op when nothing is complete.
   */
  runOnce(now?: Date): Promise<void>;
}

export function createLlmRollupEngine(db: Db): LlmRollupEngine {
  return {
    async runOnce(now = new Date()) {
      const watermark = await readWatermark(db, LLM_ROLLUP_WATERMARK_KEY);
      let dirty = false;
      for (const granularity of GRANULARITIES) {
        // Buckets starting before `floor(now)` are complete; the bucket that
        // contains `now` is still open and must not be computed yet.
        const to = floorTo(now, granularity);
        let from = watermark[granularity];
        if (from === null) {
          const earliest = await earliestLlmSnapshotTime(db);
          if (earliest === null) continue; // nothing ever received — no-op
          from = floorTo(earliest, granularity);
        }
        if (from.getTime() >= to.getTime()) continue; // clock jump back / nothing new
        await computeLlmBuckets(db, granularity, from, to);
        watermark[granularity] = to;
        dirty = true;
      }
      if (dirty) await writeWatermark(db, LLM_ROLLUP_WATERMARK_KEY, watermark);
    },
  };
}

async function earliestLlmSnapshotTime(db: Db): Promise<Date | null> {
  // Column select (not a raw sql field) so drizzle applies the timestamptz
  // parser and we get a real Date back.
  const [row] = await db
    .select({ earliest: llmSnapshots.serverTime })
    .from(llmSnapshots)
    .orderBy(asc(llmSnapshots.serverTime))
    .limit(1);
  return row?.earliest ?? null;
}
