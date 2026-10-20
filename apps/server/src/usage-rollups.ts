import { asc, sql, type SQL } from "drizzle-orm";
import { llmRequests } from "@irori/db";
import type { Db } from "@irori/db";
import {
  floorTo,
  granularityLiteral,
  readWatermark,
  writeWatermark,
  bucketStartExpr,
  type Granularity,
} from "./rollups.js";

/**
 * Usage rollups (M8, ADR-0008 §5): hourly/daily `usage_buckets` per
 * (node, model) keyed on SERVER receive time (`received_at`) — the agent
 * request `ts` is advisory and never affects bucketing, so replayed rows
 * always land inside the watermark recompute window. Watermark lives under
 * its own settings key (no minute buckets for usage).
 */
export const USAGE_ROLLUP_WATERMARK_KEY = "usage_rollup_watermark";

const USAGE_GRANULARITIES: readonly Granularity[] = ["hour", "day"];

/** Raw requests in [fromTs, toTs) projected to rollup inputs. */
function perRequestCte(fromTs: Date, toTs: Date): SQL {
  return sql`
    with per_request as (
      select
        node_id,
        coalesce(model, '') as model,
        received_at as server_time,
        (error is not null or status >= 400) as failed,
        prompt_tokens,
        completion_tokens,
        cached_tokens,
        reasoning_tokens,
        total_tokens,
        ttft_ms,
        duration_ms,
        decode_tps
      from llm_requests
      where received_at >= ${fromTs.toISOString()} and received_at < ${toTs.toISOString()}
    )
  `;
}

/**
 * Aggregates raw usage into `granularity` buckets starting in [fromTs, toTs),
 * upserted per (node_id, model). TTFT/duration percentiles ignore nulls;
 * decodeTps is completion-token-weighted with the weight stored for
 * re-weighting on merge. Returns the number of buckets written.
 */
export async function computeUsageBuckets(
  db: Db,
  granularity: Granularity,
  fromTs: Date,
  toTs: Date,
): Promise<number> {
  if (fromTs.getTime() >= toTs.getTime()) return 0;
  const bucketStart = bucketStartExpr(granularity);
  const result = await db.execute(sql`
    ${perRequestCte(fromTs, toTs)}
    insert into usage_buckets
      (node_id, model, granularity, bucket_start, requests, errors,
       prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, total_tokens,
       ttft_p50_ms, ttft_p95_ms, duration_p95_ms, decode_tps, decode_tps_weight)
    select
      node_id,
      model,
      ${granularityLiteral(granularity)},
      ${bucketStart},
      count(*)::int as requests,
      count(*) filter (where failed)::int as errors,
      coalesce(sum(prompt_tokens), 0)::bigint,
      coalesce(sum(completion_tokens), 0)::bigint,
      coalesce(sum(cached_tokens), 0)::bigint,
      coalesce(sum(reasoning_tokens), 0)::bigint,
      coalesce(sum(total_tokens), 0)::bigint,
      percentile_cont(0.5) within group (order by ttft_ms)::float8,
      percentile_cont(0.95) within group (order by ttft_ms)::float8,
      percentile_cont(0.95) within group (order by duration_ms)::float8,
      (sum(completion_tokens * decode_tps) / nullif(sum(completion_tokens), 0))::float8,
      coalesce(sum(completion_tokens) filter (where decode_tps is not null), 0)::bigint
    from per_request
    group by node_id, model, ${bucketStart}
    on conflict (node_id, model, granularity, bucket_start) do update set
      requests = excluded.requests,
      errors = excluded.errors,
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      cached_tokens = excluded.cached_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      total_tokens = excluded.total_tokens,
      ttft_p50_ms = excluded.ttft_p50_ms,
      ttft_p95_ms = excluded.ttft_p95_ms,
      duration_p95_ms = excluded.duration_p95_ms,
      decode_tps = excluded.decode_tps,
      decode_tps_weight = excluded.decode_tps_weight
    returning node_id
  `);
  return result.length;
}

export interface UsageRollupEngine {
  runOnce(now?: Date): Promise<void>;
}

export function createUsageRollupEngine(db: Db): UsageRollupEngine {
  return {
    async runOnce(now = new Date()) {
      const watermark = await readWatermark(db, USAGE_ROLLUP_WATERMARK_KEY);
      let dirty = false;
      for (const granularity of USAGE_GRANULARITIES) {
        const to = floorTo(now, granularity);
        let from = watermark[granularity];
        if (from === null) {
          const earliest = await earliestUsageTime(db);
          if (earliest === null) continue;
          from = floorTo(earliest, granularity);
        }
        if (from.getTime() >= to.getTime()) continue;
        await computeUsageBuckets(db, granularity, from, to);
        watermark[granularity] = to;
        dirty = true;
      }
      if (dirty) await writeWatermark(db, USAGE_ROLLUP_WATERMARK_KEY, watermark);
    },
  };
}

async function earliestUsageTime(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ earliest: llmRequests.receivedAt })
    .from(llmRequests)
    .orderBy(asc(llmRequests.receivedAt))
    .limit(1);
  return row?.earliest ?? null;
}
