import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { auditLog } from "@irori/db";
import type { Db } from "@irori/db";
import { redactAuditValue, type AuditActor, type AuditEntry, type AuditOutcome, type AuditPage, type AuditQuery } from "@irori/core";

/**
 * Durable audit log (IRI-077, epic IR-157 WS4). One row per mutating hub
 * route: who acted, on what, before/after (redacted), outcome. The SSE feed
 * is an in-memory ring; this is the record that survives a restart.
 *
 * `record()` never throws — an audit write failure must not fail the operator
 * action it describes — but it does log, so a broken audit path is visible
 * rather than silent.
 */

/** What a caller hands the recorder before the action runs. */
export interface AuditInput {
  actor: AuditActor;
  actorDetail?: string | null;
  /** `domain.verb`, e.g. `node.delete`. */
  action: string;
  targetType: string;
  targetId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  sourceAddr?: string | null;
}

/** Result of a recorded action; `error` marks the row `outcome: "error"`. */
export interface AuditResult {
  outcome: AuditOutcome;
  error?: string | null;
  /** Merge additional state into `after` (e.g. the ids a dispatch produced). */
  after?: unknown;
}

export interface AuditService {
  /** Fire-and-forget record used by route handlers. */
  record(input: AuditInput, result?: AuditResult): void;
  /** Awaitable variant for tests and non-HTTP callers (retention, hub-internal). */
  write(input: AuditInput, result?: AuditResult): Promise<void>;
  list(query: AuditQuery): Promise<AuditPage>;
  /** Delete rows older than `keepDays`; returns the deleted count. */
  prune(keepDays: number): Promise<number>;
}

const SUMMARY_CAP = 512;
const ERROR_CAP = 512;
const COUNT_CAP = 10_000;
const RANGE_DAYS: Record<AuditQuery["range"], number> = {
  "1h": 1 / 24,
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

function serialize(value: unknown): unknown {
  if (value === undefined) return null;
  const redacted = redactAuditValue(value);
  try {
    // JSON round-trip both bounds size and strips values Postgres would
    // reject in jsonb (BigInt, Date, functions) before they reach the insert.
    return JSON.parse(JSON.stringify(redacted));
  } catch {
    return { truncated: true };
  }
}

export function createAuditService(db: Db, log: (msg: string, err?: unknown) => void = () => {}): AuditService {
  const toEntry = (row: typeof auditLog.$inferSelect): AuditEntry => ({
    // DB mode is number; the wire is a decimal string (JSON-safe).
    id: String(row.id),
    ts: row.ts.toISOString(),
    actor: row.actor as AuditActor,
    actorDetail: row.actorDetail,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    summary: row.summary,
    before: row.before ?? null,
    after: row.after ?? null,
    outcome: row.outcome as AuditOutcome,
    error: row.error,
    requestId: row.requestId,
    sourceAddr: row.sourceAddr,
  });

  const insert = async (input: AuditInput, result?: AuditResult): Promise<void> => {
    const outcome: AuditOutcome = result?.outcome ?? "ok";
    const after = result?.after !== undefined ? result.after : input.after;
    await db.insert(auditLog).values({
      actor: input.actor,
      actorDetail: input.actorDetail ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      summary: (input.summary ?? `${input.action} ${input.targetType}`).slice(0, SUMMARY_CAP),
      before: serialize(input.before) as never,
      after: serialize(after) as never,
      outcome,
      error: result?.error ? String(result.error).slice(0, ERROR_CAP) : null,
      requestId: input.requestId ?? null,
      sourceAddr: input.sourceAddr ?? null,
    });
  };

  const conditions = (query: AuditQuery) => {
    const where = [gte(auditLog.ts, new Date(Date.now() - RANGE_DAYS[query.range] * 86_400_000))];
    if (query.actor) where.push(eq(auditLog.actor, query.actor));
    if (query.action) where.push(eq(auditLog.action, query.action));
    if (query.domain) where.push(like(auditLog.action, `${query.domain}.%`));
    if (query.targetId) where.push(eq(auditLog.targetId, query.targetId));
    if (query.q) {
      const needle = `%${query.q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
      where.push(sql`(${auditLog.summary} ilike ${needle} or ${auditLog.action} ilike ${needle} or ${auditLog.targetId} ilike ${needle})`);
    }
    if (query.cursor !== undefined) where.push(sql`${auditLog.id} < ${Number(query.cursor)}`);
    return and(...where);
  };

  return {
    record(input, result) {
      void insert(input, result).catch((err) => log("audit write failed", { err, action: input.action, target: input.targetId }));
    },

    async write(input, result) {
      await insert(input, result);
    },

    async list(query) {
      const where = conditions(query);
      const rows = await db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const [counted] = await db
        .select({ n: sql<number>`least(count(*)::int, ${COUNT_CAP})::int` })
        .from(auditLog)
        .where(query.cursor === undefined ? where : conditions({ ...query, cursor: undefined }));
      return {
        entries: page.map(toEntry),
        nextCursor: rows.length > query.limit && page.length > 0 ? String(page[page.length - 1]!.id) : null,
        total: counted?.n ?? 0,
      };
    },

    async prune(keepDays) {
      const cutoff = new Date(Date.now() - keepDays * 86_400_000);
      const rows = await db.execute<{ n: number }>(sql`
        with deleted as (
          delete from audit_log where ts < ${cutoff.toISOString()} returning 1
        )
        select count(*)::int as n from deleted
      `);
      return rows[0]?.n ?? 0;
    },
  };
}
