import { asc, sql, type SQL } from "drizzle-orm";
import { llmRequests } from "@irori/db";
import type { Db } from "@irori/db";
import { tokenCostMinor, type Currency } from "@irori/core";
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
 *
 * IRI-072: when `resolvePrice` is provided, a second pass stamps
 * `cost_minor`/`cost_currency` per bucket from the group's token sums —
 * rounding ONCE per bucket, null (never fake zero) when no pricing resolves.
 * Failed requests keep their prompt tokens in cost (the `errors` count marks
 * them); nothing is excluded.
 */
export async function computeUsageBuckets(
  db: Db,
  granularity: Granularity,
  fromTs: Date,
  toTs: Date,
  resolvePrice?: (model: string) => Promise<{ input: number; cached: number; output: number; currency: Currency } | null>,
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
  const written = result.length;
  if (resolvePrice !== undefined) await stampBucketCost(db, granularity, fromTs, toTs, resolvePrice);
  return written;
}

/**
 * IRI-072 cost pass: per (node, model, bucket) token sums from the same
 * window, priced in JS with the shared `tokenCostMinor` (one rounding per
 * bucket), stamped onto the bucket rows. Runs after the aggregate upsert so
 * a watermark recompute of the open window keeps cost fresh when prices
 * change.
 */
async function stampBucketCost(
  db: Db,
  granularity: Granularity,
  fromTs: Date,
  toTs: Date,
  resolvePrice: (model: string) => Promise<{ input: number; cached: number; output: number; currency: Currency } | null>,
): Promise<number> {
  const bucketStart = bucketStartExpr(granularity);
  const groups = await db.execute(sql`
    ${perRequestCte(fromTs, toTs)}
    select node_id, model, ${bucketStart} as bucket_start,
           coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
           coalesce(sum(cached_tokens), 0)::bigint as cached_tokens,
           coalesce(sum(completion_tokens), 0)::bigint as completion_tokens
    from per_request
    group by node_id, model, ${bucketStart}
  `);
  let stamped = 0;
  for (const g of groups) {
    const price = await resolvePrice(String(g.model));
    const costMinor = tokenCostMinor(
      { promptTokens: Number(g.prompt_tokens), cachedTokens: Number(g.cached_tokens), completionTokens: Number(g.completion_tokens) },
      price,
    );
    // Count only genuine null→priced transitions: a null price is a legitimate
    // no-op, and re-stamping an already-priced bucket is not progress.
    if (costMinor === null) continue;
    const [res] = await db.execute(sql`
      with updated as (
        update usage_buckets set
          cost_minor = ${costMinor},
          cost_currency = ${price?.currency ?? null}
        where node_id = ${g.node_id} and model = ${String(g.model)}
          and granularity = ${granularityLiteral(granularity)} and bucket_start = ${new Date(g.bucket_start as string).toISOString()}::timestamptz
          and cost_minor is null
        returning 1
      )
      select count(*)::int as n from updated
    `);
    stamped += res === undefined ? 0 : Number(res.n);
  }
  return stamped;
}

export interface UsageRollupEngine {
  runOnce(now?: Date): Promise<void>;
}

/**
 * IRI-072: idempotent, chunked, resumable backfill — stamps cost onto
 * COMPLETED buckets whose cost is still null (rows predating the cost
 * engine). `maxBuckets` bounds each pass; call repeatedly (e.g. from the
 * prune loop) until `remaining` is 0. Returns the buckets stamped this pass.
 */
export async function backfillUsageCost(
  db: Db,
  resolvePrice: (model: string) => Promise<{ input: number; cached: number; output: number; currency: Currency } | null>,
  maxBuckets = 500,
): Promise<{ stamped: number; remaining: number }> {
  const nulls = await db.execute(sql`
    select node_id, model, granularity, bucket_start
    from usage_buckets
    where cost_minor is null and bucket_start < date_trunc('hour', now())
    order by bucket_start
    limit ${maxBuckets}
  `);
  let stamped = 0;
  const pricedModels = new Set<string>();
  for (const row of nulls) {
    const granularity = String(row.granularity) as Granularity;
    const model = String(row.model);
    const start = new Date(row.bucket_start as string);
    const to = new Date(Math.min(start.getTime() + (granularity === "hour" ? 3_600_000 : 24 * 3_600_000), Date.now()));
    stamped += await stampBucketCost(db, granularity, start, to, resolvePrice);
    if ((await resolvePrice(model)) !== null) pricedModels.add(model);
  }
  // `remaining` counts null buckets that CAN still be priced (the loop's
  // termination signal) — unpriced models legitimately stay null forever.
  if (pricedModels.size === 0) return { stamped, remaining: 0 };
  const modelList = [...pricedModels];
  const [left] = await db.execute(sql`
    select count(*)::int as n from usage_buckets
    where cost_minor is null and bucket_start < date_trunc('hour', now()) and model in (${sql.join(modelList.map((m) => sql`${m}`), sql`, `)})
  `);
  return { stamped, remaining: left === undefined ? 0 : Number(left.n) };
}

export function createUsageRollupEngine(
  db: Db,
  pricing?: () => Promise<{ currency: Currency | null; resolve(model: string): { input: number; cached: number; output: number; currency: Currency } | null } | null>,
): UsageRollupEngine {
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
        // One pricing snapshot per pass; the resolver is synchronous per group.
        const snap = pricing === undefined ? null : await pricing().catch(() => null);
        const resolver = snap === null ? undefined : async (m: string) => snap.resolve(m);
        await computeUsageBuckets(db, granularity, from, to, resolver);
        if (resolver !== undefined) await backfillUsageCost(db, resolver, 200);
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
