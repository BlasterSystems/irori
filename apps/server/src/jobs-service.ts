import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { cleanupRuns, jobOutput, jobs, modelMeta, nodeModels, settings } from "@irori/db";
import type { Db } from "@irori/db";
import { hygieneResultSchemaFor, jobKindSchema } from "@irori/core";
import { isUniqueViolation } from "./pg.js";

/**
 * Persists a hygiene job's structured result into cleanup_runs: the agent's
 * FINAL output line is the JSON report (audit or clean), validated by the
 * core schema. Runs that already settled (double done, reap-after-done) are
 * left alone.
 */
async function settleCleanupRun(db: Db, jobId: string, kind: "hygiene-audit" | "hygiene-clean", status: "succeeded" | "failed" | "canceled"): Promise<void> {
  const [last] = await db
    .select({ line: jobOutput.line })
    .from(jobOutput)
    .where(eq(jobOutput.jobId, jobId))
    .orderBy(desc(jobOutput.seq))
    .limit(1);
  let report: unknown = null;
  let parseError: string | null = null;
  if (last !== undefined) {
    try {
      const parsed = hygieneResultSchemaFor(kind).safeParse(JSON.parse(last.line));
      if (parsed.success) report = parsed.data;
      else parseError = "final output is not a valid hygiene report";
    } catch {
      parseError = "final output is not JSON";
    }
  } else {
    parseError = "agent produced no output";
  }
  await db
    .update(cleanupRuns)
    .set({
      status,
      report: report === null ? null : report,
      error: status === "succeeded" && report === null ? parseError : null,
      finishedAt: new Date(),
    })
    .where(and(eq(cleanupRuns.jobId, jobId), eq(cleanupRuns.status, "running")));
}

/**
 * Jobs subsystem for apps/server (M4): one active job per node, streamed
 * output ring (last MAX_OUTPUT_LINES per job), model_meta cache from catalog
 * frames. Canonical persistence home is packages/db — kept here for the same
 * scope reason as llm-store.ts (reported to Main).
 */

export const MAX_OUTPUT_LINES = 400;

/** Job kinds that change the NAS store contents — trigger a catalog re-read. */
const CATALOG_MUTATING_KINDS = new Set([
  "download",
  "download-queue",
  "nas-delete",
  "nas-delete-apply",
  "catalog-refresh",
  "repair-active-apply",
  "gc-objects",
  "cleanup-staging",
]);

export interface JobRow {
  id: string;
  nodeId: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  params: unknown;
  exitCode: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export type JobAgentSend = (nodeId: string, msg: unknown) => boolean;

export interface JobsService {
  /** Creates + dispatches a job; returns the row. Throws JobBusyError on conflict. */
  create(nodeId: string, kind: string, params: Record<string, unknown>): Promise<JobRow>;
  get(id: string): Promise<(JobRow & { output: Array<{ seq: number; line: string }> }) | null>;
  list(nodeId: string, limit?: number): Promise<JobRow[]>;
  cancel(id: string): Promise<boolean>;
  /** Agent frame routing (hub calls these). */
  onOutput(nodeId: string, jobId: string, seq: number, line: string): Promise<void>;
  onDone(nodeId: string, jobId: string, status: "succeeded" | "failed" | "canceled", exitCode: number | null): Promise<void>;
  onCatalog(nodeId: string, source: "catalog" | "scan", entries: Array<{ name: string; runtime: string; repository: string; bytes: number }>): Promise<void>;
  /** NAS catalog entries from the model_meta cache, sorted by name. */
  listModels(): Promise<Array<{ name: string; repository: string; runtime: string; bytes: number; firstSeenAt: Date; updatedAt: Date }>>;
  /** Same rows ordered by first_seen_at descending (recently-added default). */
  listModelsByRecent(): Promise<Array<{ name: string; repository: string; runtime: string; bytes: number; firstSeenAt: Date; updatedAt: Date }>>;
  findModel(name: string): Promise<{ name: string; repository: string; runtime: string; bytes: number; firstSeenAt: Date; updatedAt: Date } | null>;
  /** Node ids where a succeeded transfer (sync/download/push source) left the model. */
  presentNodesFor(name: string): Promise<string[]>;
  /** Fails every running/queued job whose node is not in `onlineNodes`; returns affected job ids. */
  reapOffline(onlineNodes: ReadonlySet<string>): Promise<string[]>;
}

export class JobBusyError extends Error {}
export class JobDispatchError extends Error {}

const ACTIVE = ["queued", "running"] as const;

export function createJobsService(db: Db, sendToAgent: JobAgentSend): JobsService {
  return {
    async create(nodeId, kind, params) {
      jobKindSchema.parse(kind);
      const [active] = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.nodeId, nodeId), inArray(jobs.status, [...ACTIVE])))
        .limit(1);
      if (active) throw new JobBusyError(`node already has an active job (${active.id})`);
      let inserted: Array<typeof jobs.$inferSelect>;
      try {
        inserted = await db
          .insert(jobs)
          .values({ nodeId, kind, status: "queued", params })
          .returning();
      } catch (err) {
        // The partial unique index makes one-active-per-node hold under
        // concurrency; the check above is the fast path.
        if (isUniqueViolation(err)) throw new JobBusyError("node already has an active job");
        throw err;
      }
      const [row] = inserted;
      if (!row) throw new Error("job insert returned no row");
      if (kind === "hygiene-audit" || kind === "hygiene-clean") {
        // History row (SPEC §11.6): the report lands via onDone's output parse.
        await db.insert(cleanupRuns).values({
          nodeId,
          kind: kind === "hygiene-audit" ? "audit" : "clean",
          status: "running",
          categories: kind === "hygiene-clean" ? (params as { categories?: unknown }).categories ?? [] : [],
          jobId: row.id,
        });
      }
      const sent = sendToAgent(nodeId, { type: "job", jobId: row.id, kind, params });
      if (!sent) {
        await db.update(jobs).set({ status: "failed", finishedAt: new Date() }).where(eq(jobs.id, row.id));
        if (kind === "hygiene-audit" || kind === "hygiene-clean") {
          await db
            .update(cleanupRuns)
            .set({ status: "failed", error: "node is not connected", finishedAt: new Date() })
            .where(eq(cleanupRuns.jobId, row.id));
        }
        throw new JobDispatchError("node is not connected");
      }
      await db.update(jobs).set({ status: "running", startedAt: new Date() }).where(eq(jobs.id, row.id));
      return { ...row, status: "running", startedAt: new Date(), finishedAt: null, exitCode: null };
    },

    async get(id) {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      if (!row) return null;
      const output = await db
        .select({ seq: jobOutput.seq, line: jobOutput.line })
        .from(jobOutput)
        .where(eq(jobOutput.jobId, id))
        .orderBy(desc(jobOutput.seq))
        .limit(MAX_OUTPUT_LINES);
      return { ...row, output: output.reverse() };
    },

    async list(nodeId, limit = 20) {
      return db
        .select()
        .from(jobs)
        .where(eq(jobs.nodeId, nodeId))
        .orderBy(desc(jobs.createdAt))
        .limit(limit);
    },

    async cancel(id) {
      // Best-effort: the agent also gets the cancel frame (send happens via
      // the job's node; the hub routes it by the job's node id).
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      if (!row) return false;
      if (row.status === "succeeded" || row.status === "failed" || row.status === "canceled") return false;
      sendToAgent(row.nodeId, { type: "job-cancel", jobId: id });
      await db.update(jobs).set({ status: "canceled", finishedAt: new Date() }).where(eq(jobs.id, id));
      if (row.kind === "hygiene-audit" || row.kind === "hygiene-clean") {
        await db
          .update(cleanupRuns)
          .set({ status: "canceled", finishedAt: new Date() })
          .where(and(eq(cleanupRuns.jobId, id), eq(cleanupRuns.status, "running")));
      }
      return true;
    },

    async onOutput(nodeId, jobId, seq, line) {
      // Frames are keyed by jobId alone on the wire; verify the job belongs to
      // the sending node so a rogue agent cannot forge another node's output.
      const [owner] = await db.select({ nodeId: jobs.nodeId }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!owner || owner.nodeId !== nodeId) return;
      await db.insert(jobOutput).values({ jobId, seq, line });
      // Ring: drop anything beyond the cap for this job.
      await db.execute(sql`
        DELETE FROM job_output WHERE job_id = ${jobId} AND seq <= ${seq - MAX_OUTPUT_LINES}
      `);
    },

    async onDone(nodeId, jobId, status, exitCode) {
      const [owner] = await db.select({ nodeId: jobs.nodeId }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!owner || owner.nodeId !== nodeId) return;
      await db
        .update(jobs)
        .set({ status, exitCode, finishedAt: new Date() })
        .where(and(eq(jobs.id, jobId), inArray(jobs.status, [...ACTIVE])));
      const [row] = await db.select({ kind: jobs.kind, params: jobs.params }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!row) return;
      if (row.kind === "hygiene-audit" || row.kind === "hygiene-clean") {
        await settleCleanupRun(db, jobId, row.kind, status);
      } else if (row.kind === "hygiene-prevent") {
        // Prevention state (SPEC §11.6): log rotation applied iff the agent
        // wrote daemon.json successfully.
        const key = `hygiene:${nodeId}`;
        const [prev] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
        const state = { ...((typeof prev?.value === "object" && prev.value !== null ? prev.value : {}) as Record<string, unknown>), logRotationApplied: status === "succeeded" };
        await db.insert(settings).values({ key, value: state }).onConflictDoUpdate({ target: settings.key, set: { value: state } });
      }
      const name = typeof row.params === "object" && row.params !== null && "name" in row.params ? String((row.params as { name: unknown }).name) : "";
      // Keep the per-node model inventory in step with what actually succeeded.
      if (status === "succeeded" && name.length > 0) {
        if (row.kind === "sync-local" || row.kind === "download" || row.kind === "push") {
          await db.insert(nodeModels).values({ nodeId, model: name }).onConflictDoNothing();
        } else if (row.kind === "delete-local" || row.kind === "nas-delete-apply") {
          await db.delete(nodeModels).where(and(eq(nodeModels.nodeId, nodeId), eq(nodeModels.model, name)));
        }
      }
      // Store contents may have changed: ask the node to re-report its catalog
      // so the Models page reflects downloads/deletes without manual refresh.
      if (status === "succeeded" && CATALOG_MUTATING_KINDS.has(row.kind)) {
        sendToAgent(nodeId, { type: "catalog-request" });
      }
    },

    async onCatalog(nodeId, source, entries) {
      void nodeId;
      for (const e of entries) {
        await db
          .insert(modelMeta)
          .values({ name: e.name, repository: e.repository, runtime: e.runtime, bytes: e.bytes, meta: { source } })
          .onConflictDoUpdate({
            target: modelMeta.name,
            set: { repository: e.repository, runtime: e.runtime, bytes: e.bytes, updatedAt: new Date() },
          });
      }
    },

    async listModels() {
      return db.select().from(modelMeta).orderBy(modelMeta.name);
    },

    async listModelsByRecent() {
      return db.select().from(modelMeta).orderBy(desc(modelMeta.firstSeenAt), modelMeta.name);
    },

    async findModel(name: string) {
      const [row] = await db.select().from(modelMeta).where(eq(modelMeta.name, name)).limit(1);
      return row ?? null;
    },

    /** Node ids whose local HF cache holds the model (node_models inventory). */
    async presentNodesFor(name: string): Promise<string[]> {
      const rows = await db.select({ nodeId: nodeModels.nodeId }).from(nodeModels).where(eq(nodeModels.model, name));
      return rows.map((r) => r.nodeId);
    },

    async reapOffline(onlineNodes) {
      const active = await db
        .select({ id: jobs.id, nodeId: jobs.nodeId })
        .from(jobs)
        .where(inArray(jobs.status, [...ACTIVE]));
      const dead = active.filter((j) => !onlineNodes.has(j.nodeId));
      for (const j of dead) {
        await db
          .update(jobs)
          .set({ status: "failed", finishedAt: new Date() })
          .where(and(eq(jobs.id, j.id), inArray(jobs.status, [...ACTIVE])));
        await db.insert(jobOutput).values({ jobId: j.id, seq: MAX_OUTPUT_LINES, line: "error: agent connection lost" });
      }
      return dead.map((j) => j.id);
    },
  };
}
