import { CADENCE_MAX_MS, CADENCE_MIN_MS } from "@irori/core";

/**
 * Server configuration. Fails fast only when DB features are used without an
 * encryption key (ADR-0002); a missing DATABASE_URL boots degraded instead.
 */
export interface Config {
  databaseUrl: string | null;
  encryptionKey: string | null;
  port: number;
  /** Snapshots older than this are pruned from the DB (ADR-0006). */
  snapshotRetentionHours: number;
  /** Bucket retention: minute buckets older than this are pruned. */
  minuteKeepDays: number;
  hourKeepDays: number;
  dayKeepDays: number;
  /** Snapshot cadence handed to agents in hello-ok (CADENCE_MS env, bounded). */
  cadenceMs: number;
  /**
   * IRI-077: audit rows kept before the retention pass deletes them.
   * Long by design — "who changed what, when" is the one table an operator
   * asks about months later.
   */
  auditKeepDays: number;
}

const DEFAULT_PORT = 3947;
const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_MINUTE_KEEP_DAYS = 7;
const DEFAULT_HOUR_KEEP_DAYS = 90;
const DEFAULT_DAY_KEEP_DAYS = 365;
const DEFAULT_CADENCE_MS = 2000;
const DEFAULT_AUDIT_KEEP_DAYS = 365;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  const encryptionKey = env.ENCRYPTION_KEY?.trim() || null;

  if (databaseUrl && !encryptionKey) {
    throw new Error("ENCRYPTION_KEY is required when DATABASE_URL is set (ADR-0002)");
  }

  return {
    databaseUrl,
    encryptionKey,
    port: parsePositiveInt(env.PORT, DEFAULT_PORT),
    snapshotRetentionHours: parsePositiveInt(env.SNAPSHOT_RETENTION_HOURS, DEFAULT_RETENTION_HOURS),
    minuteKeepDays: parsePositiveInt(env.MINUTE_KEEP_DAYS, DEFAULT_MINUTE_KEEP_DAYS),
    hourKeepDays: parsePositiveInt(env.HOUR_KEEP_DAYS, DEFAULT_HOUR_KEEP_DAYS),
    dayKeepDays: parsePositiveInt(env.DAY_KEEP_DAYS, DEFAULT_DAY_KEEP_DAYS),
    cadenceMs: parseCadenceMs(env.CADENCE_MS),
    auditKeepDays: parsePositiveInt(env.AUDIT_KEEP_DAYS, DEFAULT_AUDIT_KEEP_DAYS),
  };
}

/** CADENCE_MS env: bounded to the same 1–60 s window as the persisted setting. */
function parseCadenceMs(raw: string | undefined): number {
  const n = parsePositiveInt(raw, DEFAULT_CADENCE_MS);
  return Math.min(CADENCE_MAX_MS, Math.max(CADENCE_MIN_MS, n));
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
