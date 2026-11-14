import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { downloadQueue, jobs as jobsTable, nodes } from "@irori/db";
import type { Db } from "@irori/db";
import {
  deriveDownloadName,
  downloadBatchCreateSchema,
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

interface ResultsDocumentEntry {
  name: string;
  status: "complete" | "failed";
  error: string | null;
  errorType: string | null;
}

/**
 * Extracts the modelctl `queue --json` results document from batch output:
 * a single compact JSON line (`{"schema":1,"results":[…]}`) printed as the
 * LAST stdout line. Older modelctl pins emit no document → null (the caller
 * falls back to the terminal-line parser).
 */
export function parseResultsDocument(output: Array<{ line: string }>): { results: ResultsDocumentEntry[] } | null {
  for (let i = output.length - 1; i >= 0; i--) {
    const line = output[i]!.line;
    if (!line.startsWith(`{"schema":1,`)) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || !("results" in parsed) || !Array.isArray(parsed.results)) return null;
      const results: ResultsDocumentEntry[] = [];
      for (const r of parsed.results) {
        if (typeof r !== "object" || r === null) return null;
        const e = r as Record<string, unknown>;
        if (typeof e.name !== "string" || (e.status !== "complete" && e.status !== "failed")) return null;
        results.push({
          name: e.name,
          status: e.status,
          error: typeof e.error === "string" ? e.error : null,
          errorType: typeof e.error_type === "string" ? e.error_type : null,
        });
      }
      return { results };
    } catch {
      return null; // a malformed document is not a fallback signal — use lines
    }
  }
  return null;
}

/** Row → API DTO (dates as ISO strings). */
export function toDownloadDto(row: Row): DownloadQueueEntry {
  return {
    id: row.id,
    source: row.source,
    name: row.name,
    quantization: row.quantization,
    mtp: row.mtp,
    force: row.force,
    bytesDone: row.bytesDone,
    bytesTotal: row.bytesTotal,
    speedBps: row.speedBps,
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

/** One modelctl progress event (IRI-017). */
export interface DownloadProgress {
  entry: number | null;
  name: string | null;
  bytesDone: number;
  bytesTotal: number | null;
  speedBps: number | null;
}

/**
 * Extracts a modelctl progress event from a batch output line (IRI-017).
 * Contract: modelctl emits `progress: {…}` JSONL lines on stderr with at
 * least `bytes_done` (plus optional `entry`, `name`, `bytes_total`,
 * `speed_bps`). Lines emitted by modelctl pins without the feature simply
 * never match → null.
 */
export function parseProgressLine(line: string): DownloadProgress | null {
  if (!line.startsWith("progress: ")) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice("progress: ".length));
    if (typeof parsed !== "object" || parsed === null) return null;
    const e = parsed as Record<string, unknown>;
    if (typeof e.bytes_done !== "number" || !Number.isFinite(e.bytes_done) || e.bytes_done < 0) return null;
    return {
      entry: typeof e.entry === "number" && Number.isInteger(e.entry) && e.entry > 0 ? e.entry : null,
      name: typeof e.name === "string" && e.name.length > 0 ? e.name : null,
      bytesDone: e.bytes_done,
      bytesTotal: typeof e.bytes_total === "number" && Number.isFinite(e.bytes_total) && e.bytes_total >= 0 ? e.bytes_total : null,
      speedBps: typeof e.speed_bps === "number" && Number.isFinite(e.speed_bps) && e.speed_bps >= 0 ? e.speed_bps : null,
    };
  } catch {
    return null;
  }
}

export interface DownloadQueueService {
  /** Validates + inserts a pending entry, then attempts an immediate dispatch. */
  enqueue(input: unknown): Promise<DownloadQueueEntry>;
  /** Bulk form (IRI-015): N entries in one atomic submission + one drain attempt. */
  enqueueBatch(input: unknown): Promise<DownloadQueueEntry[]>;
  list(): Promise<DownloadQueueEntry[]>;
  /** Removes a pending or terminal row; a running entry must settle first. */
  remove(id: string): Promise<void>;
  /** Re-queues a failed/canceled entry and attempts a dispatch. */
  retry(id: string, opts?: { force?: boolean }): Promise<DownloadQueueEntry>;
  /**
   * IRI-017: live progress for the running batch — parses one job output
   * line and updates the matching running row's byte/speed columns. No-op
   * for non-progress lines, unknown jobs, or rows that already settled.
   */
  onJobOutput(jobId: string, line: string): Promise<void>;
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
    const pending = await db
      .select()
      .from(downloadQueue)
      .where(eq(downloadQueue.status, "pending"))
      // Batch rows share createdAt (one INSERT), so id breaks the tie —
      // onJobOutput maps progress entry indexes against THIS exact order.
      .orderBy(downloadQueue.createdAt, downloadQueue.id);
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
        downloads: pending.map((r) => ({
          source: r.source,
          name: r.name,
          ...(r.quantization === null ? {} : { quantization: r.quantization }),
          ...(r.mtp === null ? {} : { mtp: r.mtp }),
          ...(r.force ? { force: true } : {}),
        })),
        jobs: batchJobs,
      });
      await db
        .update(downloadQueue)
        .set({ status: "running", jobId: job.id, error: null, bytesDone: null, bytesTotal: null, speedBps: null, updatedAt: new Date() })
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
        .set({ status: "succeeded", error: null, speedBps: null, updatedAt: now })
        .where(eq(downloadQueue.jobId, jobId));
      return;
    }
    if (status === "canceled") {
      await db
        .update(downloadQueue)
        .set({ status: "canceled", error: "batch canceled", speedBps: null, updatedAt: now })
        .where(eq(downloadQueue.jobId, jobId));
      // A canceled batch may still have published earlier entries.
      sendToAgent(nodeId, { type: "catalog-request" });
      return;
    }
    const detail = await jobs.get(jobId);
    // Preferred: the modelctl `queue --json` results document (a single
    // compact JSON line, the LAST stdout line when the pinned modelctl
    // supports it). Fallback: the `[i/n] complete|failed` terminal lines
    // (older modelctl versions).
    const doc = parseResultsDocument(detail?.output ?? []);
    if (doc !== null) {
      const verdicts = new Map<string, { status: "succeeded" | "failed"; error: string | null }>();
      for (const r of doc.results) {
        verdicts.set(
          r.name,
          r.status === "complete"
            ? { status: "succeeded", error: null }
            : { status: "failed", error: r.error === null ? "failed" : r.errorType === null ? r.error : `${r.errorType}: ${r.error}` },
        );
      }
      for (const row of rows) {
        const verdict = verdicts.get(row.name);
        if (verdict === undefined) {
          await db.update(downloadQueue).set({ status: "failed", error: "did not complete in the batch", speedBps: null, updatedAt: now }).where(eq(downloadQueue.id, row.id));
        } else {
          await db.update(downloadQueue).set({ status: verdict.status, error: verdict.error, speedBps: null, updatedAt: now }).where(eq(downloadQueue.id, row.id));
        }
      }
      // Partial failure: published entries still changed the store — refresh.
      sendToAgent(nodeId, { type: "catalog-request" });
      return;
    }
    const completed = new Set<string>();
    const failedMsgs = new Map<string, string>();
    for (const { line } of detail?.output ?? []) {
      let m = /^\[\d+\/\d+\] complete: (.+?) -> /.exec(line);
      if (m) {
        completed.add(m[1]!);
        continue;
      }
      m = /^\[\d+\/\d+\] failed: (.+?): /.exec(line);
      if (m) {
        failedMsgs.set(m[1]!, line);
        continue;
      }
      // IR-244: preflight refusals name each entry on its own line — the
      // batch died before any transfer, so there are no [i/n] lines and no
      // results doc. The typed reason is the text after "entry N (name):";
      // the "preflight: validating …" summary line matches neither shape.
      m = /^\s*entry \d+ \((.+)\): (.+)$/.exec(line);
      if (m && !failedMsgs.has(m[1]!)) failedMsgs.set(m[1]!, m[2]!);
    }
    for (const row of rows) {
      if (completed.has(row.name)) {
        await db.update(downloadQueue).set({ status: "succeeded", error: null, speedBps: null, updatedAt: now }).where(eq(downloadQueue.id, row.id));
      } else {
        const error = failedMsgs.get(row.name) ?? "did not complete in the batch";
        await db.update(downloadQueue).set({ status: "failed", error, speedBps: null, updatedAt: now }).where(eq(downloadQueue.id, row.id));
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
      const name = parsed.data.name ?? deriveDownloadName(parsed.data.source, parsed.data.quantization);
      const [row] = await db
        .insert(downloadQueue)
        .values({
          source: parsed.data.source,
          name,
          quantization: parsed.data.quantization,
          mtp: parsed.data.mtp,
          force: parsed.data.force === true,
          jobs: parsed.data.jobs,
        })
        .returning();
      if (!row) throw new Error("download queue insert returned no row");
      await dispatchIfIdle();
      const [fresh] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, row.id)).limit(1);
      return toDownloadDto(fresh ?? row);
    },

    async enqueueBatch(input) {
      const parsed = downloadBatchCreateSchema.safeParse(input);
      if (!parsed.success) {
        throw new DownloadValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      // Atomic: one insert for the whole submission (any invalid entry
      // rejected above → nothing lands).
      const inserted = await db
        .insert(downloadQueue)
        .values(
          parsed.data.downloads.map((e) => ({
            source: e.source,
            name: e.name ?? deriveDownloadName(e.source, e.quantization),
            quantization: e.quantization,
            mtp: e.mtp,
            force: e.force === true,
            jobs: parsed.data.jobs,
          })),
        )
        .returning();
      await dispatchIfIdle();
      const fresh = await db.select().from(downloadQueue).where(inArray(downloadQueue.id, inserted.map((r) => r.id)));
      const byId = new Map(fresh.map((r) => [r.id, toDownloadDto(r)]));
      // A concurrent remove() between dispatch and re-select drops a row from
      // `fresh` — skip it instead of echoing an undefined entry.
      return inserted.map((r) => byId.get(r.id)).filter((e): e is DownloadQueueEntry => e !== undefined);
    },

    async list() {
      // Batch rows share createdAt — id breaks the tie so the UI order is stable.
      const rows = await db
        .select()
        .from(downloadQueue)
        .orderBy(desc(downloadQueue.createdAt), desc(downloadQueue.id))
        .limit(LIST_LIMIT);
      return rows.map(toDownloadDto);
    },

    async remove(id) {
      const [row] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).limit(1);
      if (!row) throw new DownloadNotFoundError("download entry not found");
      if (row.status === "running") throw new DownloadBusyError("entry is in the running batch — cancel the job instead");
      await db.delete(downloadQueue).where(eq(downloadQueue.id, id));
    },

    async retry(id, opts) {
      const [row] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).limit(1);
      if (!row) throw new DownloadNotFoundError("download entry not found");
      if (row.status !== "failed" && row.status !== "canceled") {
        throw new DownloadInvalidTransitionError(`only failed or canceled entries can be retried (${row.status})`);
      }
      await db
        .update(downloadQueue)
        .set({
          status: "pending",
          jobId: null,
          error: null,
          ...(opts?.force === true ? { force: true } : {}),
          bytesDone: null,
          bytesTotal: null,
          speedBps: null,
          updatedAt: new Date(),
        })
        .where(eq(downloadQueue.id, id));
      await dispatchIfIdle();
      const [fresh] = await db.select().from(downloadQueue).where(eq(downloadQueue.id, id)).limit(1);
      if (!fresh) throw new DownloadNotFoundError("download entry not found");
      return toDownloadDto(fresh);
    },

    async onJobOutput(jobId, line) {
      const progress = parseProgressLine(line);
      if (progress === null) return;
      // Same (createdAt, id) order as the dispatch select: batch rows share
      // createdAt, so id is the only stable entry-index tiebreaker.
      const rows = await db
        .select()
        .from(downloadQueue)
        .where(and(eq(downloadQueue.jobId, jobId), eq(downloadQueue.status, "running")))
        .orderBy(downloadQueue.createdAt, downloadQueue.id);
      if (rows.length === 0) return;
      let target: Row | undefined;
      if (progress.name !== null) target = rows.find((r) => r.name === progress.name);
      if (target === undefined && progress.entry !== null) target = rows[progress.entry - 1];
      if (target === undefined && rows.length === 1) target = rows[0]!;
      if (target === undefined) return;
      await db
        .update(downloadQueue)
        .set({
          bytesDone: Math.round(progress.bytesDone),
          ...(progress.bytesTotal === null ? {} : { bytesTotal: Math.round(progress.bytesTotal) }),
          ...(progress.speedBps === null ? {} : { speedBps: Math.round(progress.speedBps) }),
          updatedAt: new Date(),
        })
        // A job-done frame can settle the batch while this frame is in flight,
        // and a retried row may already run under a NEW job — never write
        // stale progress onto those.
        .where(and(eq(downloadQueue.id, target.id), eq(downloadQueue.status, "running"), eq(downloadQueue.jobId, jobId)));
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
