import { and, desc, eq, gte, ilike, inArray, lt, sql, type SQL } from "drizzle-orm";
import { logDropCounters, logs } from "@irori/db";
import type { Db } from "@irori/db";
import {
  levelsAtLeast,
  logEventSchema,
  type LogEvent,
  type LogPage,
  type LogQuery,
  type LogRow,
  type LogSummary,
} from "@irori/core";

/**
 * Durable hub-side log store (IRI-078, epic IR-157 WS4). Ingests agent
 * batches (dedupe on eventId — redelivery after a crash is a no-op, the same
 * contract as the usage store), answers filtered/cursor reads, keeps the
 * per-node drop counters visible, and prunes raw while keeping warn+ (the
 * policy the operator asked for: "what went wrong" survives, noise doesn't).
 *
 * Ingest mirrors usage-store's failure discipline: malformed events are
 * counted and warned (rate-limited) but never block the batch — the agent
 * acks what the store accepted, so a bad event is dropped exactly once.
 */

/** Range → window in ms (logQuerySchema enum). */
const RANGE_MS: Record<LogQuery["range"], number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

const DROPPED_LOG_INTERVAL_MS = 60_000;

export interface LogStore {
  /**
   * Inserts a batch (dedupe on eventId) and folds the agent's cumulative
   * drop count into the per-node counter. Returns the highest stored id for
   * the node (tail resume hint; null when nothing was stored this batch).
   */
  ingestBatch(nodeId: string, events: LogEvent[], dropped: number): Promise<{ inserted: number; latestId: string | null }>;
  list(query: LogQuery): Promise<LogPage>;
  summary(query: Omit<LogQuery, "limit" | "cursor" | "after">): Promise<LogSummary>;
  /** Delete raw rows older than the cutoff; warn+ rows survive. */
  pruneRaw(olderThan: Date): Promise<number>;
  /** Delete every row older than the hard cutoff (queue-cap hygiene). */
  pruneAll(olderThan: Date): Promise<number>;
}

export function createLogStore(
  db: Db,
  /** Rate-limited warn sink (injectable for tests). */
  warn: (msg: string) => void = () => {},
  now: () => number = () => Date.now(),
): LogStore {
  let droppedCount = 0;
  let lastDroppedLogMs = 0;

  const toRow = (row: typeof logs.$inferSelect): LogRow => ({
    // BIGINT in number mode; the wire is a decimal string (JSON-safe).
    id: String(row.id),
    eventId: row.eventId,
    nodeId: row.nodeId,
    ts: row.ts.toISOString(),
    eventTs: row.eventTs,
    scope: row.scope as LogRow["scope"],
    setupId: row.setupId,
    runId: row.runId,
    jobId: row.jobId,
    level: row.level as LogRow["level"],
    source: row.source as LogRow["source"],
    seq: row.seq,
    line: row.line,
  });

  /** Shared WHERE builder for list/summary — keeps the two reads consistent. */
  const whereFor = (q: Omit<LogQuery, "limit" | "cursor" | "after">, cursorId?: string, afterId?: string): SQL[] => {
    const clauses: SQL[] = [gte(logs.ts, new Date(now() - RANGE_MS[q.range]))];
    if (q.nodeId) clauses.push(eq(logs.nodeId, q.nodeId));
    if (q.setupId) clauses.push(eq(logs.setupId, q.setupId));
    if (q.runId) clauses.push(eq(logs.runId, q.runId));
    if (q.jobId) clauses.push(eq(logs.jobId, q.jobId));
    if (q.scope) clauses.push(eq(logs.scope, q.scope));
    if (q.source) clauses.push(eq(logs.source, q.source));
    if (q.level) clauses.push(inArray(logs.level, levelsAtLeast(q.level)));
    if (q.q) clauses.push(ilike(logs.line, `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
    if (cursorId !== undefined) clauses.push(lt(logs.id, Number(cursorId)));
    if (afterId !== undefined) clauses.push(sql`${logs.id} > ${Number(afterId)}`);
    return clauses;
  };

  const truncatedFor = async (q: Omit<LogQuery, "limit" | "cursor" | "after">, clauses: SQL[]): Promise<boolean> => {
    const nodeIds = await db
      .selectDistinct({ nodeId: logs.nodeId })
      .from(logs)
      .where(and(...clauses));
    if (nodeIds.length === 0) return false;
    // Heuristic, documented: a node whose queue dropped anything inside the
    // window truncates the view. The counter is cumulative-per-node; the
    // lastDropAt stamp is what ties a drop to a time window.
    const anyDropped = await db
      .select({ one: sql<number>`1` })
      .from(logDropCounters)
      .where(
        and(
          inArray(logDropCounters.nodeId, nodeIds.map((r) => r.nodeId)),
          sql`${logDropCounters.dropped} > 0`,
          gte(logDropCounters.lastDropAt, new Date(now() - RANGE_MS[q.range])),
        ),
      )
      .limit(1);
    return anyDropped.length > 0;
  };

  return {
    async ingestBatch(nodeId, events, dropped) {
      if (events.length === 0) return { inserted: 0, latestId: null };
      const accepted: LogEvent[] = [];
      for (const event of events) {
        const parsed = logEventSchema.safeParse(event);
        if (!parsed.success) {
          // Same discipline as usage-store: never block the batch, never
          // vanish silently (the agent acks what we accept).
          droppedCount += 1;
          if (now() - lastDroppedLogMs >= DROPPED_LOG_INTERVAL_MS) {
            lastDroppedLogMs = now();
            warn(`log ingest dropped ${droppedCount} malformed event(s) on node ${nodeId} since the last warning`);
            droppedCount = 0;
          }
          continue;
        }
        accepted.push(parsed.data);
      }
      if (accepted.length > 0) {
        await db
          .insert(logs)
          .values(
            accepted.map((e) => ({
              eventId: e.eventId,
              nodeId,
              ts: new Date(),
              eventTs: e.ts,
              scope: e.scope,
              setupId: e.setupId,
              runId: e.runId,
              jobId: e.jobId,
              level: e.level,
              source: e.source,
              seq: e.seq,
              line: e.line,
            })),
          )
          // eventId dedupe on redelivery; (setup, run, seq) collision skips a
          // replayed line instead of crashing the ingest chain.
          .onConflictDoNothing();
      }
      if (accepted.length === 0 && dropped === 0) return { inserted: 0, latestId: null };
      if (dropped > 0) {
        await db
          .insert(logDropCounters)
          .values({ nodeId, dropped, lastDropAt: new Date() })
          .onConflictDoUpdate({
            target: logDropCounters.nodeId,
            // The agent's count is cumulative since agent start; take the max
            // so a hub restart (which forgets nothing here) never double-counts.
            set: {
              dropped: sql`GREATEST(${logDropCounters.dropped}, ${dropped})`,
              lastDropAt: new Date(),
            },
          });
      }
      if (accepted.length === 0) return { inserted: 0, latestId: null };
      const [top] = await db
        .select({ id: logs.id })
        .from(logs)
        .where(eq(logs.nodeId, nodeId))
        .orderBy(desc(logs.id))
        .limit(1);
      return { inserted: accepted.length, latestId: top === undefined ? null : String(top.id) };
    },

    async list(query) {
      const clauses = whereFor(query, query.cursor, query.after);
      const tail = query.after !== undefined;
      const rows = await db
        .select()
        .from(logs)
        .where(and(...clauses))
        .orderBy(tail ? logs.id : desc(logs.id))
        .limit(query.limit);
      const stored = rows.map(toRow);
      let nextCursor: string | null = null;
      let latestId: string | null = null;
      if (tail) {
        // Ascending page: the last row is the newest — that's the resume point.
        if (stored.length > 0) latestId = stored[stored.length - 1]!.id;
      } else {
        if (rows.length === query.limit) nextCursor = stored[stored.length - 1]!.id;
        // Newest stored id in range (tail resume point for a fresh load).
        const [topRow] = await db
          .select({ id: logs.id })
          .from(logs)
          .where(and(...whereFor(query)))
          .orderBy(desc(logs.id))
          .limit(1);
        if (topRow !== undefined) latestId = String(topRow.id);
      }
      return { rows: stored, nextCursor, latestId, truncated: await truncatedFor(query, clauses) };
    },

    async summary(query) {
      const clauses = whereFor(query);
      const rows = await db
        .select({ level: logs.level, n: sql<number>`count(*)::int` })
        .from(logs)
        .where(and(...clauses))
        .groupBy(logs.level);
      const counts = { trace: 0, debug: 0, info: 0, warn: 0, error: 0 } as Record<LogRow["level"], number>;
      let total = 0;
      for (const row of rows) {
        if (row.level in counts) {
          counts[row.level as LogRow["level"]] = row.n;
          total += row.n;
        }
      }
      return { counts, total, truncated: await truncatedFor(query, clauses) };
    },

    async pruneRaw(olderThan) {
      // 30 d raw… but warn+ is kept 180 d (pruneAll enforces that second
      // window); here drop only the below-warn rows. level is NOT NULL.
      const result = await db
        .delete(logs)
        .where(and(lt(logs.ts, olderThan), inArray(logs.level, ["trace", "debug", "info"])))
        .returning({ id: logs.id });
      return result.length;
    },

    async pruneAll(olderThan) {
      const result = await db.delete(logs).where(lt(logs.ts, olderThan)).returning({ id: logs.id });
      return result.length;
    },
  };
}
