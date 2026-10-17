import { sql } from "drizzle-orm";
import type { Db, NodeStore } from "@irori/db";
import type { Granularity } from "./rollups.js";

export interface RetentionPolicy {
  /** Raw snapshots older than this are deleted. */
  rawHours: number;
  minuteKeepDays: number;
  hourKeepDays: number;
  dayKeepDays: number;
}

export interface RetentionResult {
  raw: number;
  minute: number;
  hour: number;
  day: number;
}

/**
 * Deletes buckets of one granularity older than `keepDays`. Returns the
 * deleted row count (counted in SQL, never materialized).
 */
export async function pruneBuckets(db: Db, granularity: Granularity, keepDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000);
  const rows = await db.execute<{ n: number }>(sql`
    with deleted as (
      delete from snapshot_buckets
      where granularity = ${sql.raw(`'${granularity}'`)}::bucket_granularity and bucket_start < ${cutoff.toISOString()}
      returning 1
    )
    select count(*)::int as n from deleted
  `);
  return rows[0]?.n ?? 0;
}

/**
 * One retention pass: prune raw snapshots via the store, then every bucket
 * granularity. Raw pruning runs first so nothing is deleted before the
 * rollup engine had its chance (boot runs rollups before the first pass).
 */
export async function runRetention(
  store: Pick<NodeStore, "pruneSnapshots">,
  db: Db,
  policy: RetentionPolicy,
): Promise<RetentionResult> {
  const raw = await store.pruneSnapshots(new Date(Date.now() - policy.rawHours * 3_600_000));
  const minute = await pruneBuckets(db, "minute", policy.minuteKeepDays);
  const hour = await pruneBuckets(db, "hour", policy.hourKeepDays);
  const day = await pruneBuckets(db, "day", policy.dayKeepDays);
  return { raw, minute, hour, day };
}
