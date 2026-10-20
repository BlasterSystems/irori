import { sql } from "drizzle-orm";
import type { Db, NodeStore } from "@irori/db";
import type { Granularity } from "./rollups.js";
import type { LlmStore } from "./llm-store.js";
import type { UsageStore } from "./usage-store.js";

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

export interface LlmRetentionResult {
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

/**
 * One llm retention pass: prune raw llm_snapshots first, then llm_buckets
 * per granularity (same knobs as the hardware retention). Raw pruning runs
 * first so nothing is deleted before the llm rollup engine had its chance
 * (boot runs llm rollups before the first pass).
 */
export async function runLlmRetention(
  llmStore: Pick<LlmStore, "pruneLlmSnapshots" | "pruneLlmBuckets">,
  policy: RetentionPolicy,
): Promise<LlmRetentionResult> {
  const raw = await llmStore.pruneLlmSnapshots(new Date(Date.now() - policy.rawHours * 3_600_000));
  const minute = await llmStore.pruneLlmBuckets("minute", policy.minuteKeepDays);
  const hour = await llmStore.pruneLlmBuckets("hour", policy.hourKeepDays);
  const day = await llmStore.pruneLlmBuckets("day", policy.dayKeepDays);
  return { raw, minute, hour, day };
}

export interface UsageRetentionResult {
  raw: number;
  hour: number;
  day: number;
}

/**
 * One usage retention pass (M8, ADR-0008 §6): raw `llm_requests` 90 d,
 * `usage_buckets` 1 y. Raw pruning runs first so nothing is deleted before
 * the usage rollup engine had its chance (boot runs rollups first).
 */
export async function runUsageRetention(
  usage: Pick<UsageStore, "pruneRaw" | "pruneBuckets">,
  rawKeepDays: number,
  bucketKeepDays: number,
): Promise<UsageRetentionResult> {
  const raw = await usage.pruneRaw(new Date(Date.now() - rawKeepDays * 86_400_000));
  const hour = await usage.pruneBuckets("hour", bucketKeepDays);
  const day = await usage.pruneBuckets("day", bucketKeepDays);
  return { raw, hour, day };
}
