import { asc, eq, sql, type SQL } from "drizzle-orm";
import { settings, snapshots } from "@irori/db";
import type { Db } from "@irori/db";

/**
 * Snapshot rollups (IRI-003 §5, ADR-0006). Buckets are keyed by SERVER receive
 * time — agent `timestampMs` is advisory and never affects bucketing. The
 * engine is watermark-guarded: every bucket start >= the stored watermark is
 * recomputed idempotently (upsert), so a crash between compute and watermark
 * write simply recomputes the same range on the next pass.
 */
export type Granularity = "minute" | "hour" | "day";

export const GRANULARITIES: readonly Granularity[] = ["minute", "hour", "day"];

/** settings key holding { minute: iso, hour: iso, day: iso } watermark. */
export const ROLLUP_WATERMARK_KEY = "rollup_watermark";

const GRANULARITY_MS: Record<Granularity, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/**
 * Aggregates raw snapshots into `granularity` buckets for every bucket start
 * in [fromTs, toTs) and upserts them into snapshot_buckets. Per snapshot the
 * `gpus` array is folded across cards (usage/temp = max, power/mem = sum) and
 * `network` across interfaces (sum); across samples temps keep min/avg/max
 * while every other metric averages. Nulls are ignored by the SQL aggregates,
 * so unreadable metrics never skew a bucket. Returns the number of buckets
 * written. Empty ranges are a no-op. Safe to run every 60s.
 */
export async function computeBuckets(
  db: Db,
  granularity: Granularity,
  fromTs: Date,
  toTs: Date,
): Promise<number> {
  if (fromTs.getTime() >= toTs.getTime()) return 0;
  const bucketStart = bucketStartExpr(granularity);
  const result = await db.execute(sql`
    ${perSnapshotCte(fromTs, toTs)}
    insert into snapshot_buckets
      (node_id, granularity, bucket_start, samples, cpu_usage_pct, cpu_temp_c, cpu_temp_min_c, cpu_temp_max_c,
       package_power_w, mem_used_bytes, mem_total_bytes, gpu_usage_pct, gpu_temp_c, gpu_temp_min_c, gpu_temp_max_c,
       gpu_power_w, gpu_mem_used_bytes, net_rx_bps, net_tx_bps)
    select
      node_id,
      ${granularityLiteral(granularity)},
      ${bucketStart},
      ${aggregateCols()}
    from per_snapshot
    group by node_id, ${bucketStart}
    on conflict (node_id, granularity, bucket_start) do update set
      samples = excluded.samples,
      cpu_usage_pct = excluded.cpu_usage_pct,
      cpu_temp_c = excluded.cpu_temp_c,
      cpu_temp_min_c = excluded.cpu_temp_min_c,
      cpu_temp_max_c = excluded.cpu_temp_max_c,
      package_power_w = excluded.package_power_w,
      mem_used_bytes = excluded.mem_used_bytes,
      mem_total_bytes = excluded.mem_total_bytes,
      gpu_usage_pct = excluded.gpu_usage_pct,
      gpu_temp_c = excluded.gpu_temp_c,
      gpu_temp_min_c = excluded.gpu_temp_min_c,
      gpu_temp_max_c = excluded.gpu_temp_max_c,
      gpu_power_w = excluded.gpu_power_w,
      gpu_mem_used_bytes = excluded.gpu_mem_used_bytes,
      net_rx_bps = excluded.net_rx_bps,
      net_tx_bps = excluded.net_tx_bps
    returning node_id
  `);
  return result.length;
}

export interface RollupEngine {
  /**
   * Processes every complete bucket (a bucket is complete once `now` reaches
   * its end) since the watermark, then advances the watermark. `now` is
   * injectable for tests. No-op when there is nothing complete to compute.
   */
  runOnce(now?: Date): Promise<void>;
}

export function createRollupEngine(db: Db): RollupEngine {
  return {
    async runOnce(now = new Date()) {
      const watermark = await readWatermark(db);
      let dirty = false;
      for (const granularity of GRANULARITIES) {
        // Buckets starting before `floor(now)` are complete; the bucket that
        // contains `now` is still open and must not be computed yet.
        const to = floorTo(now, granularity);
        let from = watermark[granularity];
        if (from === null) {
          const earliest = await earliestSnapshotTime(db);
          if (earliest === null) continue; // nothing ever received — no-op
          from = floorTo(earliest, granularity);
        }
        if (from.getTime() >= to.getTime()) continue; // clock jump back / nothing new
        await computeBuckets(db, granularity, from, to);
        watermark[granularity] = to;
        dirty = true;
      }
      if (dirty) await writeWatermark(db, watermark);
    },
  };
}

/** Floor `t` to the start of its bucket (UTC). */
function floorTo(t: Date, granularity: Granularity): Date {
  return new Date(Math.floor(t.getTime() / GRANULARITY_MS[granularity]) * GRANULARITY_MS[granularity]);
}

/**
 * Truncation happens in UTC regardless of the server session time zone, so
 * bucket starts are stable across hosts (date_trunc on timestamptz would
 * otherwise follow the session TimeZone). The granularity is embedded as a
 * literal: it comes from a closed union, and a bound parameter would break
 * the textual match between the SELECT and GROUP BY expressions.
 */
export function bucketStartExpr(granularity: Granularity): SQL {
  return sql.raw(`date_trunc('${granularity}', server_time at time zone 'UTC') at time zone 'UTC'`);
}

/** Closed-union granularity as a SQL literal (params break postgres.js serialization). */
function granularityLiteral(granularity: Granularity): SQL {
  return sql.raw(`'${granularity}'::bucket_granularity`);
}

/** Per-snapshot projection: JSON payload → typed columns, arrays folded. */
export function perSnapshotCte(fromTs: Date, toTs: Date, nodeId?: string): SQL {
  return sql`
    with per_snapshot as (
      select
        node_id,
        server_time,
        (payload->'cpu'->>'usagePct')::float8 as cpu_usage,
        (payload->'cpu'->>'tempC')::float8 as cpu_temp,
        (payload->'cpu'->>'packagePowerW')::float8 as pkg_power,
        (payload->'memory'->>'usedBytes')::float8 as mem_used,
        (payload->'memory'->>'totalBytes')::float8 as mem_total,
        (select max((g->>'usagePct')::float8) from jsonb_array_elements(payload->'gpus') g where g->>'usagePct' is not null) as gpu_usage,
        (select max((g->>'tempC')::float8) from jsonb_array_elements(payload->'gpus') g where g->>'tempC' is not null) as gpu_temp,
        (select sum((g->>'powerW')::float8) from jsonb_array_elements(payload->'gpus') g where g->>'powerW' is not null) as gpu_power,
        (select sum((g->>'memUsedBytes')::float8) from jsonb_array_elements(payload->'gpus') g where g->>'memUsedBytes' is not null) as gpu_mem,
        (select sum((n->>'rxBps')::float8) from jsonb_array_elements(payload->'network') n where n->>'rxBps' is not null) as net_rx,
        (select sum((n->>'txBps')::float8) from jsonb_array_elements(payload->'network') n where n->>'txBps' is not null) as net_tx
      from snapshots
      where server_time >= ${fromTs.toISOString()} and server_time < ${toTs.toISOString()}
      ${nodeId === undefined ? sql`` : sql`and node_id = ${nodeId}`}
    )
  `;
}

export function aggregateCols(): SQL {
  return sql`
    count(*)::int as samples,
    avg(cpu_usage)::float8 as cpu_usage_pct,
    avg(cpu_temp)::float8 as cpu_temp_avg,
    min(cpu_temp)::float8 as cpu_temp_min,
    max(cpu_temp)::float8 as cpu_temp_max,
    avg(pkg_power)::float8 as package_power_w,
    avg(mem_used)::float8 as mem_used_bytes,
    avg(mem_total)::float8 as mem_total_bytes,
    avg(gpu_usage)::float8 as gpu_usage_pct,
    avg(gpu_temp)::float8 as gpu_temp_avg,
    min(gpu_temp)::float8 as gpu_temp_min,
    max(gpu_temp)::float8 as gpu_temp_max,
    avg(gpu_power)::float8 as gpu_power_w,
    avg(gpu_mem)::float8 as gpu_mem_used_bytes,
    avg(net_rx)::float8 as net_rx_bps,
    avg(net_tx)::float8 as net_tx_bps
  `;
}

async function earliestSnapshotTime(db: Db): Promise<Date | null> {
  // Column select (not a raw sql field) so drizzle applies the timestamptz
  // parser and we get a real Date back.
  const [row] = await db
    .select({ earliest: snapshots.serverTime })
    .from(snapshots)
    .orderBy(asc(snapshots.serverTime))
    .limit(1);
  return row?.earliest ?? null;
}

interface WatermarkValue {
  minute: string | null;
  hour: string | null;
  day: string | null;
}

async function readWatermark(db: Db): Promise<Record<Granularity, Date | null>> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, ROLLUP_WATERMARK_KEY));
  const value = row?.value as Partial<WatermarkValue> | undefined;
  const parse = (raw: unknown): Date | null => {
    if (typeof raw !== "string") return null;
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date : null;
  };
  return {
    minute: parse(value?.minute),
    hour: parse(value?.hour),
    day: parse(value?.day),
  };
}

async function writeWatermark(db: Db, watermark: Record<Granularity, Date | null>): Promise<void> {
  const value: WatermarkValue = {
    minute: watermark.minute?.toISOString() ?? null,
    hour: watermark.hour?.toISOString() ?? null,
    day: watermark.day?.toISOString() ?? null,
  };
  await db
    .insert(settings)
    .values({ key: ROLLUP_WATERMARK_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}
