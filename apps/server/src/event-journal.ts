import { and, desc, eq, gte, sql } from "drizzle-orm";
import { eventJournal } from "@irori/db";
import type { Db } from "@irori/db";
import type { SseEvent } from "@irori/core";
import { FEED_EXCLUDED } from "./events-feed.js";

/**
 * Durable fleet event journal (IRI-077). The SSE recording feed keeps the
 * last 500 frames in memory and loses them on restart; this decorator writes
 * the same frames to Postgres so operational facts (job transitions, thermal
 * excursions, usage summaries) survive a deploy.
 *
 * The high-rate streams the feed already excludes (snapshot, llm,
 * job-progress, setup-log, heartbeat) are never journaled — they are caches
 * with their own durable homes (snapshot_buckets, llm_requests, logs).
 *
 * Journaling is best-effort by design: a failed insert must not stop a live
 * frame from reaching subscribers.
 */

export interface EventJournalRow {
  id: string;
  ts: string;
  type: string;
  nodeId: string | null;
  payload: unknown;
}

export interface EventJournalQuery {
  range: "1h" | "24h" | "7d" | "30d";
  type?: string;
  nodeId?: string;
  limit: number;
  /** Descending id of the last row shown. */
  cursor?: number;
}

export interface EventJournalService {
  /**
   * Persist one outgoing frame (no-op for excluded types). Awaitable so tests
   * and hub-internal writers can settle; the feed's sink ignores the promise
   * because a journal failure must never delay or break live delivery.
   */
  journal(event: SseEvent): Promise<void>;
  list(query: EventJournalQuery): Promise<{ events: EventJournalRow[]; nextCursor: number | null }>;
  /**
   * IR-179: per-node counts of one journal type inside the window. The
   * reconnect-storm health rule reads node-online bursts from here.
   */
  countByNodeSince(type: string, sinceMs: number): Promise<Array<{ nodeId: string | null; n: number }>>;
  /** Delete journaled events older than `keepDays`; returns the deleted count. */
  prune(keepDays: number): Promise<number>;
}

const RANGE_MS: Record<EventJournalQuery["range"], number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** Node-ish fields agents/frames carry; used for the node filter column. */
function nodeIdOf(event: SseEvent): string | null {
  const e = event as unknown as Record<string, unknown>;
  for (const key of ["nodeId", "node", "targetNodeId"]) {
    const v = e[key];
    if (typeof v === "string" && v.length > 0 && v.length <= 64) return v;
  }
  const setup = e["setup"] as { headNodeId?: unknown } | undefined;
  if (typeof setup?.headNodeId === "string") return setup.headNodeId;
  return null;
}

export function createEventJournalService(
  db: Db,
  log: (msg: string, err?: unknown) => void = () => {},
): EventJournalService {
  return {
    async journal(event) {
      // The feed already filters before calling this; the guard keeps direct
      // callers (tests, hub-internal writes) from journaling high-rate caches.
      if (Object.hasOwn(FEED_EXCLUDED, event.type)) return;
      try {
        await db
          .insert(eventJournal)
          .values({ type: event.type, nodeId: nodeIdOf(event), payload: JSON.parse(JSON.stringify(event)) as never });
      } catch (err) {
        // Never reject: the feed's sink calls this unawaited, and a journal
        // failure must not surface as a live-delivery or operator error.
        log("event journal write failed", { err, type: event.type });
      }
    },

    async list(query) {
      const where = [gte(eventJournal.ts, new Date(Date.now() - RANGE_MS[query.range]))];
      if (query.type) where.push(eq(eventJournal.type, query.type));
      if (query.nodeId) where.push(eq(eventJournal.nodeId, query.nodeId));
      if (query.cursor !== undefined) where.push(sql`${eventJournal.id} < ${query.cursor}`);
      const rows = await db
        .select()
        .from(eventJournal)
        .where(and(...where))
        .orderBy(desc(eventJournal.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        events: page.map((r) => ({ id: String(r.id), ts: r.ts.toISOString(), type: r.type, nodeId: r.nodeId, payload: r.payload })),
        nextCursor: rows.length > query.limit && page.length > 0 ? page[page.length - 1]!.id : null,
      };
    },

    async countByNodeSince(type, sinceMs) {
      const cutoff = new Date(Date.now() - sinceMs);
      const rows = await db
        .select({ nodeId: eventJournal.nodeId, n: sql<number>`count(*)::int` })
        .from(eventJournal)
        .where(and(eq(eventJournal.type, type), gte(eventJournal.ts, cutoff)))
        .groupBy(eventJournal.nodeId);
      return rows;
    },

    async prune(keepDays) {
      const cutoff = new Date(Date.now() - keepDays * 86_400_000);
      const rows = await db.execute<{ n: number }>(sql`
        with deleted as (
          delete from event_journal where ts < ${cutoff.toISOString()} returning 1
        )
        select count(*)::int as n from deleted
      `);
      return rows[0]?.n ?? 0;
    },
  };
}

/** Durable event retention: 90 days of operational facts. */
export const EVENT_JOURNAL_KEEP_DAYS = 90;
