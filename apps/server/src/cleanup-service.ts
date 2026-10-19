import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@irori/db";
import { cleanupRuns, nodes, settings } from "@irori/db";
import { HYGIENE_SAFE_CATEGORIES, hygieneCleanParamsSchema } from "@irori/core";

/**
 * Disk-hygiene reads + per-node prevention settings (M7, SPEC §11.6).
 * The runs themselves are written by jobs-service (lifecycle hooks); this
 * service owns the History/Audit reads and the opt-in knobs.
 */
export interface CleanupEntry {
  id: string;
  kind: string;
  status: string;
  categories: unknown;
  report: unknown;
  error: string | null;
  jobId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CleanupService {
  /** Latest audit row for the node (any age — the UI decides freshness). */
  latestAudit(nodeId: string): Promise<CleanupEntry | null>;
  /** Last 20 runs (audit + clean), newest first (History tab; 90 d kept by retention). */
  history(nodeId: string, limit?: number): Promise<CleanupEntry[]>;
  /** Per-node prevention knobs (weekly safe pass, log-rotation state). */
  prevention(nodeId: string): Promise<{ weeklySafePass: boolean; logRotationApplied: boolean }>;
  setPrevention(nodeId: string, patch: { weeklySafePass?: boolean; logRotationApplied?: boolean }): Promise<void>;
  /** Node ids with the weekly safe pass enabled. */
  weeklySafePassNodes(): Promise<string[]>;
}

const PREVENTION_PREFIX = "hygiene:";

interface PreventionState {
  weeklySafePass?: boolean;
  logRotationApplied?: boolean;
}

function readPrevention(raw: unknown): PreventionState {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw as PreventionState;
  return {};
}

export function createCleanupService(db: Db): CleanupService {
  const shape = (row: typeof cleanupRuns.$inferSelect): CleanupEntry => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    categories: row.categories,
    report: row.report,
    error: row.error,
    jobId: row.jobId,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
  });

  return {
    async latestAudit(nodeId) {
      const [row] = await db
        .select()
        .from(cleanupRuns)
        .where(and(eq(cleanupRuns.nodeId, nodeId), eq(cleanupRuns.kind, "audit")))
        .orderBy(desc(cleanupRuns.createdAt))
        .limit(1);
      return row ? shape(row) : null;
    },

    async history(nodeId, limit = 20) {
      const rows = await db.select().from(cleanupRuns).where(eq(cleanupRuns.nodeId, nodeId)).orderBy(desc(cleanupRuns.createdAt)).limit(limit);
      return rows.map(shape);
    },

    async prevention(nodeId) {
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, PREVENTION_PREFIX + nodeId));
      const state = readPrevention(row?.value);
      return { weeklySafePass: state.weeklySafePass === true, logRotationApplied: state.logRotationApplied === true };
    },

    async setPrevention(nodeId, patch) {
      const key = PREVENTION_PREFIX + nodeId;
      const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
      const state = { ...readPrevention(row?.value), ...patch };
      await db
        .insert(settings)
        .values({ key, value: state })
        .onConflictDoUpdate({ target: settings.key, set: { value: state } });
    },

    async weeklySafePassNodes() {
      const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
      return rows
        .filter((r) => r.key.startsWith(PREVENTION_PREFIX) && readPrevention(r.value).weeklySafePass === true)
        .map((r) => r.key.slice(PREVENTION_PREFIX.length))
        .filter((id) => /^[0-9a-f-]{36}$/.test(id));
    },
  };
}

/** Params for the weekly always-safe pass (SPEC §11.6). */
export function weeklySafePassParams() {
  return hygieneCleanParamsSchema.parse({ categories: [...HYGIENE_SAFE_CATEGORIES], dryRun: false });
}

/** Node existence check used by the routes. */
export async function nodeExists(db: Db, nodeId: string): Promise<boolean> {
  const [row] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  return row !== undefined;
}
