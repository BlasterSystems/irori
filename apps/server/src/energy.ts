import { sql } from "drizzle-orm";
import type { Db } from "@irori/db";
import { DEFAULT_BASE_OVERHEAD_W, GB10_SYSTEM_ENVELOPE_W } from "@irori/core";

/**
 * Monthly energy archive (M7, SPEC §9). Estimated, never wall-metered: each
 * hour bucket contributes its gpu board + cpu package readings plus the base
 * overhead, clamped to the GB10 system envelope (240 W) before integration
 * (1 h per bucket). Base overhead applies only to buckets the node actually
 * reported — offline time invents no energy. `*_coverage` records the
 * fraction of reporting buckets that carried gpu/cpu readings.
 *
 * Recomputes the current and previous month every pass (idempotent upsert,
 * two statements) — the archive self-heals after agent/server downtime.
 */
export interface EnergyEngine {
  runOnce(now?: Date): Promise<void>;
}

function monthStartUtc(t: Date): string {
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).toISOString();
}

function nextMonth(monthStartIso: string): string {
  const d = new Date(monthStartIso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export function createEnergyEngine(db: Db): EnergyEngine {
  return {
    async runOnce(now = new Date()): Promise<void> {
      const current = monthStartUtc(now);
      const previous = monthStartUtc(new Date(Date.parse(current) - 1));
      for (const month of [previous, current]) {
        await computeMonth(db, month, nextMonth(month));
      }
    },
  };
}

export async function computeMonth(db: Db, monthStart: string, monthEnd: string): Promise<void> {
  await db.execute(sql`
    insert into energy_monthly
      (node_id, month_start, samples, gpu_wh, cpu_wh, base_wh, total_wh, gpu_coverage, cpu_coverage)
    select
      node_id,
      date_trunc('month', bucket_start at time zone 'UTC') at time zone 'UTC',
      count(*)::int,
      sum(coalesce(gpu_power_w, 0))::float8,
      sum(coalesce(package_power_w, 0))::float8,
      ${DEFAULT_BASE_OVERHEAD_W} * count(*)::int::float8,
      sum(least(coalesce(gpu_power_w, 0) + coalesce(package_power_w, 0) + ${DEFAULT_BASE_OVERHEAD_W}, ${GB10_SYSTEM_ENVELOPE_W}))::float8,
      avg(case when gpu_power_w is not null then 1 else 0 end)::float8,
      avg(case when package_power_w is not null then 1 else 0 end)::float8
    from snapshot_buckets
    where granularity = 'hour'
      and samples > 0
      and bucket_start >= ${monthStart} and bucket_start < ${monthEnd}
    group by node_id, date_trunc('month', bucket_start at time zone 'UTC') at time zone 'UTC'
    on conflict (node_id, month_start) do update set
      samples = excluded.samples,
      gpu_wh = excluded.gpu_wh,
      cpu_wh = excluded.cpu_wh,
      base_wh = excluded.base_wh,
      total_wh = excluded.total_wh,
      gpu_coverage = excluded.gpu_coverage,
      cpu_coverage = excluded.cpu_coverage
  `);
}
