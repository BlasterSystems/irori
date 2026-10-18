import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { jobOutput, jobs, modelMeta } from "@irori/db";
import type { Db } from "@irori/db";
import { jobKindSchema } from "@irori/core";

/**
 * Jobs subsystem for apps/server (M4): one active job per node, streamed
 * output ring (last MAX_OUTPUT_LINES per job), model_meta cache from catalog
 * frames. Canonical persistence home is packages/db — kept here for the same
 * scope reason as llm-store.ts (reported to Main).
 */

export const MAX_OUTPUT_LINES = 400;

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
  listModels(): Promise<Array<{ name: string; repository: string; runtime: string; bytes: number; updatedAt: Date }>>;
  findModel(name: string): Promise<{ name: string; repository: string; runtime: string; bytes: number; updatedAt: Date } | null>;
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
      const [row] = await db
        .insert(jobs)
        .values({ nodeId, kind, status: "queued", params })
        .returning();
      if (!row) throw new Error("job insert returned no row");
      const sent = sendToAgent(nodeId, { type: "job", jobId: row.id, kind, params });
      if (!sent) {
        await db.update(jobs).set({ status: "failed", finishedAt: new Date() }).where(eq(jobs.id, row.id));
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
      return true;
    },

    async onOutput(nodeId, jobId, seq, line) {
      await db.insert(jobOutput).values({ jobId, seq, line });
      // Ring: drop anything beyond the cap for this job.
      await db.execute(sql`
        DELETE FROM job_output WHERE job_id = ${jobId} AND seq <= ${seq - MAX_OUTPUT_LINES}
      `);
      void nodeId;
    },

    async onDone(nodeId, jobId, status, exitCode) {
      void nodeId;
      await db
        .update(jobs)
        .set({ status, exitCode, finishedAt: new Date() })
        .where(and(eq(jobs.id, jobId), inArray(jobs.status, [...ACTIVE])));
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

    async findModel(name: string) {
      const [row] = await db.select().from(modelMeta).where(eq(modelMeta.name, name)).limit(1);
      return row ?? null;
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
