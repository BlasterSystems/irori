import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { downloadQueue, jobs as jobsTable, nodes } from "@irori/db";
import type { Db } from "@irori/db";
import {
  deriveDownloadName,
  downloadCreateSchema,
  pickStoreNode,
  type DownloadQueueEntry,
  type DownloadQueueStatus,
} from "@irori/core";
import type { JobAgentSend, JobSettledEvent, JobsService } from "./jobs-service.js";

/**
 * Server-side download queue (IRI-014). Adding a download always forms a
 * pending row; pending rows dispatch to the store node (NAS-preferred,
 * `pickStoreNode`) as ONE `download-queue` batch whenever the node is idle.
 * modelctl's queue is an invocation-scoped YAML (ADR-0004) — the durable
 * queue is this table, drained through the existing one-active-per-node job
 * model (ADR-0003). Batch outcomes reconcile back onto the rows:
 *
 * - job succeeded → every entry succeeded (modelctl exits non-zero if ANY
 *   entry failed, so exit 0 proves the whole batch published).
 * - job canceled → every entry canceled.
 * - job failed → modelctl prints one terminal line per entry
 *   (`[i/n] complete: NAME -> path` / `[i/n] failed: NAME: Type: msg`, where
 *   NAME is the store name) as the LAST output lines, so the ring (last 400)
 *   retains them: completed names succeed, the rest fail.
 */

const ACTIVE = ["queued", "running"] as const;
/** Queue history returned by list(); terminal rows accumulate here. */
const LIST_LIMIT = 50;

export class DownloadNotFoundError extends Error {}
export class DownloadBusyError extends Error {}
export class DownloadInvalidTransitionError extends Error {}
export class DownloadValidationError extends Error {}

type Row = typeof downloadQueue.$inferSelect;

/** Row → API DTO (dates as ISO strings). */
export function toDownloadDto(row: Row): DownloadQueueEntry {
  return {
    id: row.id,
    source: row.source,
    name: row.name,
    status: row.status as DownloadQueueStatus,
    jobId: row.jobId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DownloadQueueDeps {
  db: Db;
  jobs: JobsService;
  /** Direct agent send — catalog-request on partially-failed batches. */
  sendToAgent: JobAgentSend;
  /** Node ids with a connected agent (hub online set). */
  online: () => ReadonlySet<string>;
}

export interface DownloadQueueService {
  /** Validates + inserts a pending entry, then attempts an immediate dispatch. */
  enqueue(input: unknown): Promise<DownloadQueueEntry>;
  list(): Promise<DownloadQueueEntry[]>;
  /** Removes a pending or terminal row; a running entry must settle first. */
  remove(id: string): Promise<void>;
  /** Re-queues a failed/canceled entry and attempts a dispatch. */
  retry(id: string): Promise<DownloadQueueEntry>;
  /** Terminal batch → row reconcile; hub settles call this (index wiring). */
  onJobSettled(event: JobSettledEvent): Promise<void>;
  /** Boot reconcile: settle rows whose batch already ended, then drain. */
  recover(): Promise<void>;
  /** Drain attempt when idle — piggybacks on the reaper interval. */
  dispatchIfIdle(): Promise<void>;
}

export function createDownloadQueueService(deps: DownloadQueueDeps): DownloadQueueService {
  const { db, jobs, sendToAgent, online } = deps;

  async function dispatchIfIdle(): Promise<void> {
    // An orphan can only arise from the jobs FK cascade (a deleted node's
    // download_queue rows lose their jobId): running + no jobId is never a
    // live state — settle it instead of waiting for a server restart.
    await db
      .update(downloadQueue)
      .set({ status: "failed", error: "batch job reference lost", updatedAt: new Date() })
      .where(and(eq(downloadQueue.status, "running"), isNull(downloadQueue.jobId)));
    const pending = await db.select().from(downloadQueue).where(eq(downloadQueue.status, "pending")).orderBy(downloadQueue.createdAt);
    if (pending.length === 0) return;
    const nodeRows = await db.select().from(nodes);
    const node = pickStoreNode(nodeRows, online());
    if (node === null) return; // no online store node: entries stay pending
    const [active] = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(eq(jobsTable.nodeId, node.id), inArray(jobsTable.status, [...ACTIVE])))
      .limit(1);
    if (active) return; // one-active-per-node: the reaper tick retries
    // Batch concurrency: the max across entries never under-serves a requester.
    const batchJobs = Math.max(...pending.map((r) => r.jobs));
    try {
      const job = await jobs.create(node.id, "download-queue", {
        downloads: pending.map((r) => ({ source: r.source, name: r.name })),
        jobs: batchJobs,
      });
      await db
        .update(downloadQueue)
        .set({ status: "running", jobId: job.id, error: null, updatedAt: new Date() })
        .where(inArray(downloadQueue.id, pending.map((r) => r.id)));
    } catch (err) {
      // JobBusy (a job raced in) / dispatch failure (node dropped): entries
      // stay pending; the reaper tick and the next settle retry the drain.
      if (err instanceof Error && (err.name === "ZodError" || err instanceof TypeError)) throw err;
    }
  }

  /** Reconciles every row of a terminal batch (see module doc). */
  async function settleBatch(jobId: string, status: "succeeded" | "failed" | "canceled", nodeId: string): Promise<void> {
    const rows = await db.select().from(downloadQueue).where(eq(downloadQueue.jobId, jobId));
    if (rows.length === 0) return; // e.g. wizard-chained download-queue jobs (setups)
    const now = new Date();
    if (status === "succeeded") {
      await db
        .update(downloadQueue)
        .set({ status: "succeeded", error: null, updatedAt: now })
        .where(eq(downloadQueue.jobId, jobId));
      return;
    }
    if (status === "canceled") {
      await db
        .update(downloadQueue)
        .set({ status: "canceled", error: "batch canceled", updatedAt: now })
        .where(eq(downloadQueue.jobId, jobId));
      // A canceled batch may still have published earlier entries.
      sendToAgent(nodeId, { type: "catalog-request" });
      return;
    }
    const detail = await jobs.get(jobId);
    const completed = new Set<string>();
    const failedMsgs = new Map<string, string>();
    for (const { line } of detail?.output ?? []) {
      let m = /^\[\d+\/\d+\] complete: (.+?) -> /.exec(line);
      if (m) {
        completed.add(m[1]!);
        continue;
      }
      m = /^\[\d+\/\d+\] failed: (.+?): /.exec(line);
      if (m) failedMsgs.set(m[1]!, line);
    }
    for (const row of rows) {
      if (completed.has(row.name)) {
        await db.update(downloadQueue).set({ status: "succeeded", error: null, updatedAt: now }).where(eq(downloadQueue.id, row.id));
      } else {
        const error = failedMsgs.get(row.name) ?? "did not complete in the batch";
        await db.update(downloadQueue).set({ status: "failed", error, updatedAt: now }).where(eq(downloadQueue.id, row.id));
      }
    }
    // Partial failure: published entries still changed the store — refresh.
    sendToAgent(nodeId, { type: "catalog-request" });
  }

  return {
    async enqueue(input) {
      const parsed = downloadCreateSchema.safeParse(input);
      if (!parsed.success) {
        throw new DownloadValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      const name = parsed.data.name ?? deriveDownloadName(parsed.data.source);
      const [row] = await db
        .insert(downloadQueue)
        .values({ source: parsed.data.source, name, jobs: parsed.data.jobs })
        .returning();
      if (!row) throw new Error("download queue insert returned no row");
      await dispatchIfIdle();
      const [fresh] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, row.id)).limit(1);
      return toDownloadDto(fresh ?? row);
    },

    async list() {
      const rows = await db.select().from(downloadQueue).orderBy(desc(downloadQueue.createdAt)).limit(LIST_LIMIT);
      return rows.map(toDownloadDto);
    },

    async remove(id) {
      const [row] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).limit(1);
      if (!row) throw new DownloadNotFoundError("download entry not found");
      if (row.status === "running") throw new DownloadBusyError("entry is in the running batch — cancel the job instead");
      await db.delete(downloadQueue).where(eq(downloadQueue.id, id));
    },

    async retry(id) {
      const [row] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).limit(1);
      if (!row) throw new DownloadNotFoundError("download entry not found");
      if (row.status !== "failed" && row.status !== "canceled") {
        throw new DownloadInvalidTransitionError(`only failed or canceled entries can be retried (${row.status})`);
      }
      await db
        .update(downloadQueue)
        .set({ status: "pending", jobId: null, error: null, updatedAt: new Date() })
        .where(eq(downloadQueue.id, id));
      await dispatchIfIdle();
      const [fresh] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).limit(1);
      if (!fresh) throw new DownloadNotFoundError("download entry not found");
      return toDownloadDto(fresh);
    },

    async onJobSettled(event) {
      if (event.kind === "download-queue") await settleBatch(event.jobId, event.status, event.nodeId);
      // Any terminal job frees the store node's single slot — try to drain.
      // Covers batch completion AND unrelated jobs ending while entries wait.
      await dispatchIfIdle();
    },

    dispatchIfIdle,

    async recover() {
      const running = await db.select().from(downloadQueue).where(eq(downloadQueue.status, "running"));
      for (const row of running) {
        if (row.jobId === null) {
          await db
            .update(downloadQueue)
            .set({ status: "failed", error: "batch job reference lost", updatedAt: new Date() })
            .where(eq(downloadQueue.id, row.id));
          continue;
        }
        const job = await jobs.get(row.jobId);
        if (job === null) {
          await db
            .update(downloadQueue)
            .set({ status: "failed", error: "batch job missing", updatedAt: new Date() })
            .where(eq(downloadQueue.id, row.id));
          continue;
        }
        if (job.status !== "queued" && job.status !== "running") {
          // The batch already settled while the server was down (job rows are
          // durable): reconcile from its recorded outcome.
          await settleBatch(row.jobId, job.status, job.nodeId);
        }
        // Still active: the agent reports job-done, or the reaper settles it —
        // both flow back through onJobSettled.
      }
      await dispatchIfIdle();
    },
  };
}
