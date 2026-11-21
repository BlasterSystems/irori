import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { cleanupRuns, jobOutput, jobs, modelMeta, nodeInventory, nodeModels, settings } from "@irori/db";
import type { Db } from "@irori/db";
import { hygieneResultSchemaFor, jobKindSchema, compareVersions, nodeInventorySchema, parseTransferProgress, type NodeInventory, type ScannedModel, type TransferProgress } from "@irori/core";
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
 * IRI-028: persists a succeeded `models-inventory` job's JSON report (the
 * agent's FINAL output line, validated against the core schema) into
 * node_inventory. A failed job leaves the previous report untouched.
 */
async function settleInventory(db: Db, nodeId: string, jobId: string): Promise<NodeInventory | null> {
  const [last] = await db
    .select({ line: jobOutput.line })
    .from(jobOutput)
    .where(eq(jobOutput.jobId, jobId))
    .orderBy(desc(jobOutput.seq))
    .limit(1);
  if (last === undefined) return null;
  let report: unknown;
  try {
    report = JSON.parse(last.line);
  } catch {
    return null;
  }
  const parsed = nodeInventorySchema.safeParse(report);
  if (!parsed.success) return null;
  const updatedAt = new Date();
  await db
    .insert(nodeInventory)
    .values({ nodeId, report: parsed.data, updatedAt })
    .onConflictDoUpdate({ target: nodeInventory.nodeId, set: { report: parsed.data, updatedAt } });
  return parsed.data;
}

/**
 * IR-140: reconcile the node_models presence table from a succeeded
 * models-inventory report. Presence was previously written only by settling
 * transfer jobs, so a model that reached a node outside a successful hub job
 * (registered locally, transferred before the table existed, manual modelctl
 * use, pruned job rows) never became present — placement demanded re-pushes of
 * resident models and setup start refused with "not staged". The agent's
 * `modelctl list --local` listing is the ground truth; upsert every listed
 * model. Prune stale rows ONLY when the report is known complete — at least
 * one cache read and every cache read succeeded (a failed read reports empty
 * models, and pruning on that would delete true presence).
 */
export async function reconcilePresenceFromInventory(db: Db, nodeId: string, report: NodeInventory): Promise<void> {
  const names = [...new Set(report.local.flatMap((cache) => cache.models.map((m) => m.name)))];
  if (names.length > 0) {
    await db
      .insert(nodeModels)
      .values(names.map((model) => ({ nodeId, model })))
      .onConflictDoNothing();
  }
  const complete = report.local.length > 0 && report.local.every((cache) => cache.error === null);
  if (!complete) return;
  await db
    .delete(nodeModels)
    .where(names.length === 0 ? eq(nodeModels.nodeId, nodeId) : and(eq(nodeModels.nodeId, nodeId), notInArray(nodeModels.model, names)));
}

/**
 * IR-105: after a succeeded models-inventory read, converge every cache user
 * whose reported modelctl is below the hub pin — dispatch the existing
 * version-gated `modelctl-install` job per user. IR-247: a MISSING binary
 * (version null) is converged too — skipping it left the user permanently
 * stuck ("unknown local cache user" on every per-user job). Silent skips
 * (unset pin, busy node, offline agent) just wait for the next inventory
 * read; the install job itself skips without a transfer when the version
 * satisfies the gate, so a stale env pin can never downgrade a newer binary.
 */
async function autoProvisionModelctl(
  create: (nodeId: string, kind: string, params: Record<string, unknown>) => Promise<JobRow>,
  getPin: () => Promise<string | null>,
  nodeId: string,
  report: NodeInventory,
): Promise<void> {
  const pin = await getPin();
  if (pin === null) return;
  for (const cache of report.local) {
    const version = cache.modelctlVersion;
    if (version !== null && !/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (version !== null && compareVersions(version, pin) >= 0) continue;
    try {
      await create(nodeId, "modelctl-install", { user: cache.user });
    } catch (err) {
      if (err instanceof JobBusyError || err instanceof JobDispatchError) continue;
      throw err;
    }
  }
}

/**
 * Jobs subsystem for apps/server (M4): one active job per node, streamed
 * output ring (last MAX_OUTPUT_LINES per job), model_meta cache from catalog
 * frames. Canonical persistence home is packages/db — kept here for the same
 * scope reason as llm-store.ts (reported to Main).
 */

export const MAX_OUTPUT_LINES = 400;

/**
 * IRI-012 (ADR-0007): an agent-update restarts the agent, so its job stays
 * "running" across the reconnect window. The reaper must not fail it while
 * the update is plausibly still in flight; past this grace a node that has
 * not come back settles the job as failed. Enforced by the existing 60 s
 * reaper loop (no timers/maps) — restart-safe by construction.
 */
export const AGENT_UPDATE_GRACE_MS = 10 * 60_000;

/** Job kinds that change the NAS store contents — trigger a catalog re-read.
 *  Membership here also flows into INVENTORY_MUTATING_KINDS (spread below). */
const CATALOG_MUTATING_KINDS = new Set([
  "download",
  "download-queue",
  "nas-delete",
  "nas-delete-apply",
  "nas-delete-batch",
  "catalog-refresh",
  "repair-active-apply",
  "gc-objects",
  "cleanup-staging",
]);

/** Job kinds that can change what a node holds (store or local cache) — drop
 *  the cached inventory so the next node-detail read refreshes it (IRI-028). */
const INVENTORY_MUTATING_KINDS = new Set([
  ...CATALOG_MUTATING_KINDS,
  "delete-local",
  "register-local",
  "sync-local",
  "push",
]);

export interface JobRow {
  id: string;
  nodeId: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  params: unknown;
  /** IR-131: parsed transfer progress for sync-local/push (null otherwise). */
  progress: { bytes: number | null; percent: number | null; rateBytesPerSec: number | null; etaSeconds: number | null } | null;
  /** IR-131: cancel requested but unconfirmed — the row stays running (slot
   *  held) until the agent's ack or job-done settles it. */
  cancelRequestedAt: Date | null;
  exitCode: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export type JobAgentSend = (nodeId: string, msg: unknown) => boolean;

/** Recent-job row for the global Activity drawer (IRI-028): metadata + the
 *  latest output line, so a drawer opened mid-job renders something useful
 *  before fetching the full output. */
export interface JobSummary extends JobRow {
  lastLine: string | null;
}

export interface JobsService {
  /** Creates + dispatches a job; returns the row. Throws JobBusyError on conflict. */
  create(nodeId: string, kind: string, params: Record<string, unknown>): Promise<JobRow>;
  get(id: string): Promise<(JobRow & { output: Array<{ seq: number; line: string }> }) | null>;
  list(nodeId: string, limit?: number): Promise<JobRow[]>;
  /** Recent jobs across every node, newest first, with their last output line. */
  listAll(limit?: number): Promise<JobSummary[]>;
  /** IR-262: delete every settled job row (succeeded/failed/canceled) and
   *  return the count. Queued/running rows and the active slot are untouched
   *  (job_output cascades; download_queue/cleanup_runs references go NULL). */
  clearHistory(): Promise<number>;
  /** IR-131: request cancel — marks `canceling` and frames the agent; the row
   *  settles canceled on the agent's ack or job-done, never speculatively. */
  cancel(id: string): Promise<CancelResult>;
  /** Agent frame routing (hub calls these). */
  onOutput(nodeId: string, jobId: string, seq: number, line: string): Promise<TransferProgress | null>;
  onDone(nodeId: string, jobId: string, status: "succeeded" | "failed" | "canceled", exitCode: number | null): Promise<void>;
  /** IR-131: the agent confirmed the process-group kill — settle canceled. */
  onCancelAck(nodeId: string, jobId: string): Promise<void>;
  /**
   * IR-131: settle rows this agent process can no longer be running. On every
   * hello the agent reports its in-memory active jobs; rows of this node that
   * are running/canceling but NOT reported belong to a dead process (the
   * agent restarted) — settle them failed so the one-active slot frees.
   * Old agents send no `activeJobs`; then this is a no-op (a ws reconnect
   * without a restart still has live jobs the old agent cannot report).
   */
  settleOrphansOnHello(nodeId: string, activeJobs: Array<{ jobId: string }> | undefined): Promise<void>;
  onCatalog(nodeId: string, source: "catalog" | "scan", entries: ScannedModel[]): Promise<void>;
  /** NAS catalog entries from the model_meta cache, sorted by name. */
  listModels(): Promise<Array<{ name: string; repository: string; runtime: string; bytes: number; firstSeenAt: Date; updatedAt: Date; meta: unknown }>>;
  /** Same rows ordered by first_seen_at descending (recently-added default). */
  listModelsByRecent(): Promise<Array<{ name: string; repository: string; runtime: string; bytes: number; firstSeenAt: Date; updatedAt: Date; meta: unknown }>>;
  findModel(name: string): Promise<{ name: string; repository: string; runtime: string; bytes: number; firstSeenAt: Date; updatedAt: Date } | null>;
  /** Node ids where a succeeded transfer (sync/download/push source) left the model. */
  presentNodesFor(name: string): Promise<string[]>;
  /** Fails every running/queued job whose node is not in `onlineNodes`; returns affected job ids. */
  reapOffline(onlineNodes: ReadonlySet<string>): Promise<string[]>;
  /**
   * IRI-012 (ADR-0007): settle an active agent-update job from the node's
   * hello. "succeeded" when the reported version is at or newer than
   * expectedVersion (an older report is an in-flight pre-update agent);
   * "pending" on mismatch (an old agent blip-reconnecting mid-update must not
   * fail the in-flight update — the reaper's grace is the backstop); "none"
   * when the node has no active agent-update job.
   */
  settleAgentUpdate(nodeId: string, agentVersion: string): Promise<"succeeded" | "pending" | "none">;
}

export class JobBusyError extends Error {}
export class JobDispatchError extends Error {}

const ACTIVE = ["queued", "running"] as const;

/** IR-131: rsync streams a transfer job runs with. push defaults to 4 (IR-121
 *  fleet default — every hub path passes jobs: 4); sync-local defaults to 1.
 *  Multi-stream output interleaves per-stream progress2 lines, so the hub
 *  refuses to parse a "percent of one stream" for it. */
function transferStreams(kind: string, params: unknown): number {
  if (kind !== "sync-local" && kind !== "push") return 1;
  const jobsParam = ((params ?? {}) as { jobs?: unknown }).jobs;
  if (typeof jobsParam === "number" && Number.isFinite(jobsParam) && jobsParam >= 1) return Math.floor(jobsParam);
  return kind === "push" ? 4 : 1;
}

/** Result of a cancel request (IR-131). The row is NOT terminal until the
 *  agent acks the kill or reports job-done — an offline node is a 409, never
 *  a silent canceled write. */
export type CancelResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "terminal" | "canceling" | "agent-update" | "offline" };

/** Terminal transition of a job — emitted as an SSE `job` frame (IRI-013). */
export interface JobSettledEvent {
  nodeId: string;
  jobId: string;
  kind: string;
  status: "succeeded" | "failed" | "canceled";
  exitCode: number | null;
  durationMs: number | null;
  /** IR-121: rides the SSE frame so the feed can label the model. */
  params: Record<string, unknown>;
}

/** Dispatch transition of a job — SSE `job` frame with status `running`
 *  (IRI-028), so the Activity drawer can show work it did not initiate. */
export interface JobStartedEvent {
  nodeId: string;
  jobId: string;
  kind: string;
  startedAt: Date;
  /** IR-121: rides the SSE frame so the feed can label the model. */
  params: Record<string, unknown>;
}

/** ADR-0014: a failed push whose preflight reported a provisionable gap. */
export interface PushBlockedEvent {
  jobId: string;
  nodeId: string;
  params: Record<string, unknown>;
  output: Array<{ seq: number; line: string }>;
}

/**
 * Classifies the agent's `IRORI_PREFLIGHT` lines (ADR-0014). null when the
 * failure is not a remediable preflight gap — unreachable destinations and
 * non-preflight failures (a mid-transfer modelctl error) are left alone.
 */
export function parsePushBlocked(output: Array<{ seq: number; line: string }>): {
  needsKeys: boolean;
  needsRsync: boolean;
  needsModelctl: boolean;
} | null {
  const lines = output.map((o) => o.line);
  if (!lines.some((l) => l.startsWith("IRORI_PREFLIGHT ("))) return null;
  const needsKeys = lines.some((l) => l.includes("ssh auth failed") || l.includes("host key not pinned"));
  const needsRsync = lines.some((l) => l.includes("rsync missing"));
  const needsModelctl = lines.some((l) => l.includes("modelctl missing"));
  if (!needsKeys && !needsRsync && !needsModelctl) return null;
  return { needsKeys, needsRsync, needsModelctl };
}

/**
 * IR-134: the blocker suffix of a busy 409 — `: sync-local GLM-5.3-…` (kind +
 * model when params carry one, else kind + job id). Shared by the fast path
 * and the unique-violation race path so both name the same winner.
 */
function activeJobLabel(active: { id: string; kind: string; params: unknown }): string {
  const name = (active.params as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? `: ${active.kind} ${name}` : `: ${active.kind} (${active.id})`;
}

export function createJobsService(
  db: Db,
  sendToAgent: JobAgentSend,
  onSettled?: (event: JobSettledEvent) => void,
  onStarted?: (event: JobStartedEvent) => void,
  /** IR-105: hub-pinned modelctl version; null/absent = no auto-provisioning. */
  getModelctlPin?: () => Promise<string | null>,
  /** ADR-0014: a failed push whose preflight reported a provisionable gap. */
  onPushBlocked?: (event: PushBlockedEvent) => void,
): JobsService {
  const service: JobsService = {
    async create(nodeId, kind, params) {
      jobKindSchema.parse(kind);
      const [active] = await db
        .select({ id: jobs.id, kind: jobs.kind, params: jobs.params })
        .from(jobs)
        .where(and(eq(jobs.nodeId, nodeId), inArray(jobs.status, [...ACTIVE])))
        .limit(1);
      if (active) throw new JobBusyError(`node already has an active job${activeJobLabel(active)}`);
      let inserted: Array<typeof jobs.$inferSelect>;
      try {
        inserted = await db
          .insert(jobs)
          .values({ nodeId, kind, status: "queued", params })
          .returning();
      } catch (err) {
        // The partial unique index makes one-active-per-node hold under
        // concurrency; the check above is the fast path. The loser of the race
        // still names the winner (IR-134) instead of a bare message.
        if (isUniqueViolation(err)) {
          const [winner] = await db
            .select({ id: jobs.id, kind: jobs.kind, params: jobs.params })
            .from(jobs)
            .where(and(eq(jobs.nodeId, nodeId), inArray(jobs.status, [...ACTIVE])))
            .limit(1);
          throw new JobBusyError(`node already has an active job${winner === undefined ? "" : activeJobLabel(winner)}`);
        }
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
      const startedAt = new Date();
      await db.update(jobs).set({ status: "running", startedAt }).where(eq(jobs.id, row.id));
      onStarted?.({ nodeId, jobId: row.id, kind, params, startedAt });
      return { ...row, status: "running", startedAt, finishedAt: null, exitCode: null };
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

    async listAll(limit = 20) {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), 100);
      const rows = (await db.execute(sql`
        select j.id, j.node_id as "nodeId", j.kind, j.status, j.params, j.progress as "progress",
               j.cancel_requested_at as "cancelRequestedAt",
               j.exit_code as "exitCode", j.created_at as "createdAt",
               j.started_at as "startedAt", j.finished_at as "finishedAt",
               (select o.line from job_output o where o.job_id = j.id order by o.seq desc limit 1) as "lastLine"
        from jobs j
        order by j.created_at desc
        limit ${capped}
      `)) as unknown as Array<{
        id: string;
        nodeId: string;
        kind: string;
        status: JobRow["status"];
        params: unknown;
        progress: JobRow["progress"];
        cancelRequestedAt: Date | string | null;
        exitCode: number | null;
        createdAt: Date | string;
        startedAt: Date | string | null;
        finishedAt: Date | string | null;
        lastLine: string | null;
      }>;
      return rows.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt),
        startedAt: row.startedAt === null ? null : new Date(row.startedAt),
        finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt),
        cancelRequestedAt: row.cancelRequestedAt === null ? null : new Date(row.cancelRequestedAt),
      }));
    },

    async clearHistory() {
      const deleted = await db
        .delete(jobs)
        .where(inArray(jobs.status, ["succeeded", "failed", "canceled"]))
        .returning({ id: jobs.id });
      return deleted.length;
    },

    async cancel(id): Promise<CancelResult> {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      if (!row) return { ok: false, reason: "missing" };
      if (row.status === "succeeded" || row.status === "failed" || row.status === "canceled") return { ok: false, reason: "terminal" };
      // ADR-0007: agent-update settlement is hello-driven (the restart severs
      // the socket); killing the update child would brick the agent.
      if (row.kind === "agent-update") return { ok: false, reason: "agent-update" };
      // Honest cancel (IR-131): the frame goes first — an offline node never
      // silently becomes canceled, because the detached modelctl child would
      // keep running with no row tracking it.
      if (!sendToAgent(row.nodeId, { type: "job-cancel", jobId: id })) return { ok: false, reason: "offline" };
      // Verify-before-write: the row STAYS running — the partial unique index
      // keeps holding the one-active slot until the terminal write (ack or
      // job-done). The request marker drives the UI's canceling state; a
      // concurrent second cancel (marker already set) reports `canceling`.
      const updated = await db
        .update(jobs)
        .set({ cancelRequestedAt: new Date() })
        .where(and(eq(jobs.id, id), inArray(jobs.status, [...ACTIVE]), isNull(jobs.cancelRequestedAt)))
        .returning({ id: jobs.id });
      if (updated.length === 0) {
        const [fresh] = await db.select({ status: jobs.status, cancelRequestedAt: jobs.cancelRequestedAt }).from(jobs).where(eq(jobs.id, id)).limit(1);
        if (fresh !== undefined && fresh.cancelRequestedAt !== null && (fresh.status === "running" || fresh.status === "queued")) {
          return { ok: false, reason: "canceling" };
        }
        return { ok: false, reason: "terminal" };
      }
      return { ok: true };
    },

    async onOutput(nodeId, jobId, seq, line): Promise<TransferProgress | null> {
      // Frames are keyed by jobId alone on the wire; verify the job belongs to
      // the sending node so a rogue agent cannot forge another node's output.
      const [owner] = await db.select({ nodeId: jobs.nodeId, kind: jobs.kind, params: jobs.params }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!owner || owner.nodeId !== nodeId) return null;
      await db.insert(jobOutput).values({ jobId, seq, line });
      // Ring: drop anything beyond the cap for this job.
      await db.execute(sql`
        DELETE FROM job_output WHERE job_id = ${jobId} AND seq <= ${seq - MAX_OUTPUT_LINES}
      `);
      // IR-131: persist parsed progress for single-stream transfers only —
      // --jobs>1 interleaves per-stream progress2 lines, and a percent of ONE
      // stream would be a lie (the modelctl aggregate emitter rides its own PR).
      if (transferStreams(owner.kind, owner.params) === 1) {
        const progress = parseTransferProgress(line);
        if (progress !== null) {
          await db.update(jobs).set({ progress }).where(eq(jobs.id, jobId));
          return progress;
        }
      }
      return null;
    },

    async onCancelAck(nodeId, jobId) {
      const [owner] = await db.select({ nodeId: jobs.nodeId }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!owner || owner.nodeId !== nodeId) return;
      // The kill signal is issued; settle through the shared terminal path so
      // cleanup/inventory/feed effects run exactly once (a later job-done
      // {canceled} hits the settled guard).
      await service.onDone(nodeId, jobId, "canceled", null);
    },

    async settleOrphansOnHello(nodeId, activeJobs) {
      if (activeJobs === undefined) return; // pre-IR-131 agent: no signal
      const reported = new Set(activeJobs.map((j) => j.jobId));
      const rows = await db
        .select({ id: jobs.id, kind: jobs.kind, params: jobs.params, startedAt: jobs.startedAt })
        .from(jobs)
        .where(and(eq(jobs.nodeId, nodeId), inArray(jobs.status, [...ACTIVE])));
      for (const j of rows) {
        // agent-update settlement is hello-driven (ADR-0007): the fresh
        // agent's version check owns those rows — never the orphan path
        // (the update child is not a JobManager job and is never reported).
        if (reported.has(j.id) || j.kind === "agent-update") continue;
        try {
          await db.insert(jobOutput).values({ jobId: j.id, seq: MAX_OUTPUT_LINES, line: "error: agent restarted mid-job — the process is gone" });
        } catch {
          // A colliding seq (long output ring) must not strand the remaining rows.
        }
        await service.onDone(nodeId, j.id, "failed", null);
      }
    },

    async onDone(nodeId, jobId, status, exitCode) {
      const [owner] = await db.select({ nodeId: jobs.nodeId, kind: jobs.kind }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!owner || owner.nodeId !== nodeId) return;
      // IRI-124 deploy finding: an agent-update restarts the agent, which kills
      // the systemd-run child, so the dying agent reports job-done failed with
      // a NULL exit code — while the update itself succeeded (the bundle was
      // replaced and the new agent is booting). That frame is not a verdict:
      // settleAgentUpdate (version match) or the grace reaper owns these rows.
      // A real script failure exits non-zero and still settles here.
      if (owner.kind === "agent-update" && status === "failed" && exitCode === null) return;
      // .returning() doubles as the terminal-transition guard: a repeated
      // done frame (or reap-after-done) must not re-run the settle effects
      // or re-emit the feed event.
      const settled = await db
        .update(jobs)
        .set({ status, exitCode, finishedAt: new Date() })
        .where(and(eq(jobs.id, jobId), inArray(jobs.status, [...ACTIVE])))
        .returning({ startedAt: jobs.startedAt, finishedAt: jobs.finishedAt });
      if (settled.length === 0) return;
      const [row] = await db.select({ kind: jobs.kind, params: jobs.params }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!row) return;
      if (row.kind === "hygiene-audit" || row.kind === "hygiene-clean") {
        await settleCleanupRun(db, jobId, row.kind, status);
      } else if (row.kind === "models-inventory") {
        if (status === "succeeded") {
          const report = await settleInventory(db, nodeId, jobId);
          if (report !== null) {
            // IR-140: the listing is ground truth for presence — placement and
            // start staging read node_models, which transfer settles alone
            // never fed for out-of-band models.
            await reconcilePresenceFromInventory(db, nodeId, report);
            if (getModelctlPin !== undefined) {
              await autoProvisionModelctl((n, k, p) => service.create(n, k, p), getModelctlPin, nodeId, report);
            }
          }
        }
      } else if (row.kind === "push" && status === "failed" && onPushBlocked !== undefined) {
        // ADR-0014: the preflight reported a provisionable gap (ssh trust,
        // destination rsync/modelctl) — hand the event to the remediator,
        // which fixes the gap and re-creates the push once (params guard).
        const output = await db
          .select({ seq: jobOutput.seq, line: jobOutput.line })
          .from(jobOutput)
          .where(eq(jobOutput.jobId, jobId))
          .orderBy(desc(jobOutput.seq))
          .limit(MAX_OUTPUT_LINES);
        const parsed = parsePushBlocked(output.reverse());
        if (parsed !== null && (row.params as { _remediated?: unknown } | null)?._remediated !== true) {
          try {
            onPushBlocked({ jobId, nodeId, params: (row.params ?? {}) as Record<string, unknown>, output });
          } catch {
            // Remediation is best-effort; the classified preflight lines stay in the job output.
          }
        }
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
      // The batch kind carries `names` instead of `name` (IR-209) — admit it
      // here so its own branch below runs.
      if (status === "succeeded" && (name.length > 0 || row.kind === "nas-delete-batch")) {
        if (row.kind === "sync-local" || row.kind === "download" || row.kind === "push" || row.kind === "register-local") {
          await db.insert(nodeModels).values({ nodeId, model: name }).onConflictDoNothing();
        } else if (row.kind === "delete-local" || row.kind === "nas-delete-apply") {
          await db.delete(nodeModels).where(and(eq(nodeModels.nodeId, nodeId), eq(nodeModels.model, name)));
          // IRI-018: model_meta is upsert-only (onCatalog), so a model deleted
          // from its last node would stay on the Models list forever. Drop the
          // cache row when no placement remains — a later catalog frame from a
          // node that still has the model re-upserts it.
          const [left] = await db.select({ model: nodeModels.model }).from(nodeModels).where(eq(nodeModels.model, name)).limit(1);
          if (left === undefined) await db.delete(modelMeta).where(eq(modelMeta.name, name));
        } else if (row.kind === "nas-delete-batch") {
          // IR-208/IR-209: a succeeded batch deleted every listed name — drop
          // each placement for this node, then prune cache rows that no node
          // still holds (same convention as the single-delete path above).
          const raw = typeof row.params === "object" && row.params !== null && "names" in row.params ? row.params.names : undefined;
          const names = Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
          if (names.length > 0) {
            await db.delete(nodeModels).where(and(eq(nodeModels.nodeId, nodeId), inArray(nodeModels.model, names)));
            const kept = await db.select({ model: nodeModels.model }).from(nodeModels).where(inArray(nodeModels.model, names));
            const held = new Set(kept.map((k) => k.model));
            const gone = names.filter((n) => !held.has(n));
            if (gone.length > 0) await db.delete(modelMeta).where(inArray(modelMeta.name, gone));
          }
        }
      }
      // Any model-ops settle can change what the node holds — even a failed
      // delete leaves leftovers. Drop the cached inventory so the next node
      // detail read (or the UI's post-settle refresh) rebuilds it.
      if (INVENTORY_MUTATING_KINDS.has(row.kind)) {
        await db.delete(nodeInventory).where(eq(nodeInventory.nodeId, nodeId));
      }
      // Store contents may have changed: ask the node to re-report its catalog
      // so the Models page reflects downloads/deletes without manual refresh.
      // Failed settles count too — a failed delete is exactly how an operator
      // probes an out-of-band store change, and a job may mutate the store
      // before failing; the catalog frame reconciles the cache either way.
      if (CATALOG_MUTATING_KINDS.has(row.kind)) {
        sendToAgent(nodeId, { type: "catalog-request" });
      }
      const startedAt = settled[0]!.startedAt;
      const finishedAt = settled[0]!.finishedAt;
      onSettled?.({
        nodeId,
        jobId,
        kind: row.kind,
        status,
        params: (row.params ?? {}) as Record<string, unknown>,
        exitCode,
        durationMs: startedAt !== null && finishedAt !== null ? finishedAt.getTime() - startedAt.getTime() : null,
      });
    },

    async onCatalog(nodeId, source, entries) {
      void nodeId;
      for (const e of entries) {
        // IRI-155: `companions` absent = an older agent: keep whatever is
        // stored. Present (companions, null, or {unreadable}) = this read's
        // result: it replaces the stored key.
        const known = e.companions !== undefined;
        await db
          .insert(modelMeta)
          .values({ name: e.name, repository: e.repository, runtime: e.runtime, bytes: e.bytes, meta: known ? { source, companions: e.companions } : { source } })
          .onConflictDoUpdate({
            target: modelMeta.name,
            set: {
              repository: e.repository,
              runtime: e.runtime,
              bytes: e.bytes,
              updatedAt: new Date(),
              ...(known ? { meta: sql`${modelMeta.meta} || ${JSON.stringify({ companions: e.companions })}::jsonb` } : {}),
            },
          });
      }
      // A source=catalog frame carries the agent's COMPLETE store catalog
      // (catalog.json schema 3): reconcile the cache by dropping rows the
      // store no longer has, so store changes made outside hub jobs (direct
      // modelctl) self-heal on the next frame. scan frames are a best-effort
      // active/ fallback and must never prune, and an empty frame never
      // prunes (preserve_if_empty parity with modelctl catalog refresh).
      if (source === "catalog" && entries.length > 0) {
        await db.delete(modelMeta).where(notInArray(modelMeta.name, entries.map((e) => e.name)));
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

    /**
     * Node ids whose local HF cache holds the model. The node_models table is
     * authoritative (reconciled on every inventory settle, IR-140); the cached
     * inventory report is unioned as a defense so presence is correct even
     * between a settle that wrote a report and the reconcile. A cached row is
     * deleted whenever a model-mutating job settles on its node, so a stale
     * row can never claim a deleted model is still resident.
     */
    async presentNodesFor(name: string): Promise<string[]> {
      const rows = await db.select({ nodeId: nodeModels.nodeId }).from(nodeModels).where(eq(nodeModels.model, name));
      const ids = new Set(rows.map((r) => r.nodeId));
      const cached = await db.select({ nodeId: nodeInventory.nodeId, report: nodeInventory.report }).from(nodeInventory);
      for (const row of cached) {
        if (ids.has(row.nodeId)) continue;
        const parsed = nodeInventorySchema.safeParse(row.report);
        if (!parsed.success) continue;
        if (parsed.data.local.some((cache) => cache.models.some((m) => m.name === name))) ids.add(row.nodeId);
      }
      return [...ids];
    },

    async reapOffline(onlineNodes) {
      const active = await db
        .select({ id: jobs.id, nodeId: jobs.nodeId, kind: jobs.kind, params: jobs.params, startedAt: jobs.startedAt, createdAt: jobs.createdAt })
        .from(jobs)
        .where(inArray(jobs.status, [...ACTIVE]));
      const now = Date.now();
      const dead = active.filter(
        (j) =>
          !onlineNodes.has(j.nodeId) &&
          // An agent-update is EXPECTED to lose its socket mid-flight (the
          // restart kills the agent); only fail it once the grace expires.
          !(j.kind === "agent-update" && now - j.createdAt.getTime() < AGENT_UPDATE_GRACE_MS),
      );
      for (const j of dead) {
        await db
          .update(jobs)
          .set({ status: "failed", finishedAt: new Date() })
          .where(and(eq(jobs.id, j.id), inArray(jobs.status, [...ACTIVE])));
        await db.insert(jobOutput).values({
          jobId: j.id,
          seq: MAX_OUTPUT_LINES,
          line:
            j.kind === "agent-update"
              ? "error: update timed out — the agent did not return with the expected version (rollback: cp /opt/irori/irori-agent.mjs.bak /opt/irori/irori-agent.mjs && systemctl restart irori-agent; journalctl -u irori-agent -n 50)"
              : "error: agent connection lost",
        });
        onSettled?.({
          nodeId: j.nodeId,
          jobId: j.id,
          kind: j.kind,
          status: "failed",
          params: (j.params ?? {}) as Record<string, unknown>,
          exitCode: null,
          durationMs: j.startedAt !== null ? now - j.startedAt.getTime() : null,
        });
      }
      return dead.map((j) => j.id);
    },

    async settleAgentUpdate(nodeId, agentVersion) {
      const [row] = await db
        .select({ id: jobs.id, params: jobs.params, startedAt: jobs.startedAt })
        .from(jobs)
        .where(and(eq(jobs.nodeId, nodeId), eq(jobs.kind, "agent-update"), inArray(jobs.status, [...ACTIVE])))
        .limit(1);
      if (!row) return "none";
      const expected =
        typeof row.params === "object" && row.params !== null && typeof (row.params as { expectedVersion?: unknown }).expectedVersion === "string"
          ? (row.params as { expectedVersion: string }).expectedVersion
          : null;
      // No expectedVersion → the job was created malformed (via the generic
      // jobs endpoint). It can NEVER be confirmed, so settle it failed on
      // this hello - that frees the node's single-active slot immediately.
      if (expected === null) {
        const finishedAt = new Date();
        await db
          .update(jobs)
          .set({ status: "failed", exitCode: null, finishedAt })
          .where(and(eq(jobs.id, row.id), inArray(jobs.status, [...ACTIVE])));
        await db.insert(jobOutput).values({
          jobId: row.id,
          seq: MAX_OUTPUT_LINES,
          line: "error: malformed agent-update job (missing expectedVersion) - created via the generic jobs endpoint; use POST /api/v1/nodes/:id/agent-update",
        });
        onSettled?.({
          nodeId,
          jobId: row.id,
          kind: "agent-update",
          status: "failed",
          params: (row.params ?? {}) as Record<string, unknown>,
          exitCode: null,
          durationMs: row.startedAt !== null ? finishedAt.getTime() - row.startedAt.getTime() : null,
        });
        return "succeeded";
      }
      // Mismatch → leave running while the reported version is OLDER than
      // expected: either the update is still in flight (an old agent
      // blip-reconnected) or the new bundle failed to boot (the reaper's
      // grace window settles that). A report at-or-newer than expected proves
      // the update took — the fleet may legitimately run a newer bundle than
      // the hub's own package version (dev tags move the bundle ahead of the
      // release), and only an active-slot job rows this node out.
      if (compareVersions(agentVersion, expected) < 0) return "pending";
      const finishedAt = new Date();
      await db
        .update(jobs)
        .set({ status: "succeeded", exitCode: 0, finishedAt })
        .where(and(eq(jobs.id, row.id), inArray(jobs.status, [...ACTIVE])));
      await db.insert(jobOutput).values({ jobId: row.id, seq: MAX_OUTPUT_LINES, line: `update confirmed: agent reports ${agentVersion}` });
      // IR-255: the update changed the agent — the cached inventory report was
      // collected by the previous bundle, so its parsing and counts are the old
      // agent's truth. Void it; the next node-detail read auto-dispatches a
      // fresh models-inventory on the new agent. Failure paths keep the report:
      // the agent (and its parsing) did not change.
      // Edge (accepted): a job created via the generic endpoint with a
      // non-drift expectedVersion confirms on the first hello and voids a
      // report the unchanged agent just collected — one spurious re-dispatch;
      // the UI's dedicated endpoint is drift-gated, so this is rare.
      await db.delete(nodeInventory).where(eq(nodeInventory.nodeId, nodeId));
      onSettled?.({
        nodeId,
        jobId: row.id,
        kind: "agent-update",
        status: "succeeded",
        params: (row.params ?? {}) as Record<string, unknown>,
        exitCode: 0,
        durationMs: row.startedAt !== null ? finishedAt.getTime() - row.startedAt.getTime() : null,
      });
      return "succeeded";
    },
  };
  return service;
}
