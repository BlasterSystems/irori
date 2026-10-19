import { and, desc, eq, sql } from "drizzle-orm";
import { benchConfigFor, benchResultSchemaFor, benchTypeSchema, type BenchProgress, type BenchType } from "@irori/core";
import { benchRuns, type Db } from "@irori/db";
import { isUniqueViolation } from "./pg.js";
import type { SseHub } from "./sse.js";

/**
 * Benchmarks (M6, SPEC §8/§14): run records in Postgres, dispatch through the
 * node agent, correlate terminal frames, keep the last 30 rows per type.
 * One active bench per node (409 otherwise) — benches monopolize the engine.
 */

/** Runs kept per bench type (mockups/benchmarks.html contract). */
export const BENCH_KEEP_PER_TYPE = 30;

export type BenchRunRow = typeof benchRuns.$inferSelect;

export class BenchNotFoundError extends Error {}
export class BenchBusyError extends Error {}
export class BenchOfflineError extends Error {}

export interface BenchService {
  /** Creates + dispatches a run; returns the row. Throws BenchBusyError/BenchOfflineError. */
  start(type: BenchType, nodeId: string, config: Record<string, unknown>): Promise<BenchRunRow>;
  get(id: string): Promise<BenchRunRow | null>;
  list(type: BenchType, opts?: { nodeId?: string; limit?: number }): Promise<BenchRunRow[]>;
  active(nodeId?: string): Promise<BenchRunRow[]>;
  cancel(id: string): Promise<BenchRunRow | null>;
  /** Agent frame routing (hub calls these). */
  onProgress(nodeId: string, runId: string, progress: BenchProgress): void;
  onDone(nodeId: string, runId: string, status: "completed" | "failed" | "canceled", result: unknown, error: string | null): Promise<void>;
  /** Fails running benches whose node is offline (agent dies with its node). */
  reapOffline(onlineNodes: ReadonlySet<string>): Promise<string[]>;
  /** Deletes rows beyond the newest BENCH_KEEP_PER_TYPE per type. */
  prune(): Promise<number>;
}

export type BenchAgentSend = (nodeId: string, msg: unknown) => boolean;

export function createBenchService(db: Db, sendToAgent: BenchAgentSend, sse: Pick<SseHub, "send">, log: (m: string) => void = () => {}): BenchService {
  const benchEvent = (run: BenchRunRow, progress: BenchProgress | null): void => {
    sse.send({
      type: "bench",
      serverTimeMs: Date.now(),
      runId: run.id,
      bench: run.type,
      nodeId: run.nodeId,
      status: run.status,
      progress,
    });
  };

  return {
    async start(type, nodeId, config) {
      const parsedType = benchTypeSchema.parse(type);
      // Throws ZodError → 400 when the config does not fit the bench.
      const parsed = benchConfigFor(parsedType, config);
      // The bench runs from the agent on the node itself; a client-supplied
      // host would turn every agent into a network probe. The node-local
      // engine is the only legitimate target (mirrors llm-ports hardcoding).
      const effective = { ...parsed, host: "127.0.0.1" } as typeof parsed;
      const [active] = await db
        .select({ id: benchRuns.id })
        .from(benchRuns)
        .where(and(eq(benchRuns.nodeId, nodeId), eq(benchRuns.status, "running")))
        .limit(1);
      if (active) throw new BenchBusyError(`node already has an active benchmark (${active.id})`);

      const model = typeof effective.model === "string" ? effective.model : null;
      const port = typeof effective.port === "number" ? effective.port : null;
      let inserted: Array<typeof benchRuns.$inferSelect>;
      try {
        inserted = await db
          .insert(benchRuns)
          .values({ type: parsedType, nodeId, status: "running", config: effective, model, port })
          .returning();
      } catch (err) {
        // The partial unique index makes one-active-per-node hold under
        // concurrency; the agent-side guard remains the backstop.
        if (isUniqueViolation(err)) throw new BenchBusyError("node already has an active benchmark");
        throw err;
      }
      const [row] = inserted;
      if (!row) throw new Error("bench insert returned no row");

      const sent = sendToAgent(nodeId, { type: "bench-run", runId: row.id, bench: parsedType, config: effective });
      if (!sent) {
        await db.update(benchRuns).set({ status: "failed", error: "node is not connected", finishedAt: new Date() }).where(eq(benchRuns.id, row.id));
        throw new BenchOfflineError("node is not connected");
      }
      const [dispatched] = await db.select().from(benchRuns).where(eq(benchRuns.id, row.id)).limit(1);
      if (dispatched) benchEvent(dispatched, null);
      log(`bench ${parsedType} dispatched to ${nodeId} (run ${row.id})`);
      return dispatched ?? row;
    },

    async get(id) {
      const [row] = await db.select().from(benchRuns).where(eq(benchRuns.id, id)).limit(1);
      return row ?? null;
    },

    async list(type, opts = {}) {
      const conditions = [eq(benchRuns.type, benchTypeSchema.parse(type))];
      if (opts.nodeId) conditions.push(eq(benchRuns.nodeId, opts.nodeId));
      return db
        .select()
        .from(benchRuns)
        .where(and(...conditions))
        .orderBy(desc(benchRuns.createdAt))
        .limit(Math.min(Math.max(1, opts.limit ?? 50), 100));
    },

    async active(nodeId) {
      const conditions = [eq(benchRuns.status, "running")];
      if (nodeId) conditions.push(eq(benchRuns.nodeId, nodeId));
      return db.select().from(benchRuns).where(and(...conditions));
    },

    async cancel(id) {
      const row = await db.select().from(benchRuns).where(eq(benchRuns.id, id)).limit(1).then((rows) => rows[0] ?? null);
      if (!row) throw new BenchNotFoundError("bench run not found");
      if (row.status !== "running") return row;
      sendToAgent(row.nodeId, { type: "bench-cancel", runId: row.id });
      const [updated] = await db
        .update(benchRuns)
        .set({ status: "canceled", finishedAt: new Date() })
        .where(eq(benchRuns.id, id))
        .returning();
      if (updated) benchEvent(updated, null);
      return updated ?? row;
    },

    onProgress(nodeId, runId, progress) {
      // Progress is ephemeral (SSE is the live surface); a stale or unknown
      // run id is ignored. Minimal read: just the type + ownership.
      db
        .select({ type: benchRuns.type, nodeId: benchRuns.nodeId })
        .from(benchRuns)
        .where(eq(benchRuns.id, runId))
        .limit(1)
        .then((rows) => {
          const row = rows[0];
          if (!row || row.nodeId !== nodeId) return;
          benchEvent({ id: runId, nodeId, type: row.type, status: "running" } as BenchRunRow, progress);
        })
        .catch(() => {});
    },

    async onDone(nodeId, runId, status, result, error) {
      const [row] = await db.select().from(benchRuns).where(eq(benchRuns.id, runId)).limit(1);
      if (!row || row.nodeId !== nodeId) {
        log(`bench done for unknown run ${runId} — ignored`);
        return;
      }
      if (row.status !== "running") return; // canceled while running: terminal state already recorded
      const durationMs = Math.max(0, Date.now() - row.createdAt.getTime());
      if (status === "completed") {
        const parsed = benchResultSchemaFor(row.type).safeParse(result);
        if (!parsed.success) {
          await db
            .update(benchRuns)
            .set({ status: "failed", error: "agent returned an invalid result shape", finishedAt: new Date(), durationMs })
            .where(eq(benchRuns.id, runId));
        } else {
          await db
            .update(benchRuns)
            .set({ status: "completed", result: parsed.data, finishedAt: new Date(), durationMs })
            .where(eq(benchRuns.id, runId));
        }
      } else {
        await db
          .update(benchRuns)
          .set({ status, error, finishedAt: new Date(), durationMs })
          .where(eq(benchRuns.id, runId));
      }
      const [updated] = await db.select().from(benchRuns).where(eq(benchRuns.id, runId)).limit(1);
      if (updated) benchEvent(updated, null);
      log(`bench ${row.type} run ${runId}: ${status}`);
    },

    async reapOffline(onlineNodes) {
      const rows = await db.select({ id: benchRuns.id, nodeId: benchRuns.nodeId }).from(benchRuns).where(eq(benchRuns.status, "running"));
      const dead = rows.filter((r) => !onlineNodes.has(r.nodeId));
      for (const row of dead) {
        await db
          .update(benchRuns)
          .set({ status: "failed", error: "node went offline", finishedAt: new Date() })
          // A terminal frame can land while this update is in flight (the
          // offline snapshot is already stale) — never overwrite a result.
          .where(and(eq(benchRuns.id, row.id), eq(benchRuns.status, "running")));
      }
      return dead.map((r) => r.id);
    },

    async prune() {
      // `delete … returning 1` yields an unnamed column; count the CTE instead
      // so the caller's log/return reflect reality (same shape as pruneBuckets).
      const result = await db.execute<{ n: number }>(sql`
        with ranked as (
          select id, row_number() over (partition by type order by created_at desc) as rn
          from bench_runs
        ),
        deleted as (
          delete from bench_runs where id in (select id from ranked where rn > ${BENCH_KEEP_PER_TYPE}) returning 1
        )
        select count(*)::int as n from deleted
      `);
      const rows = result as unknown as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    },
  };
}
