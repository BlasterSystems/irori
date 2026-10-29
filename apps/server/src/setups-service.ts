import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  envExportsSchema,
  modelIdMatches,
  parseTransferProgress,
  pickStoreNode,
  setupInfoSchema,
  setupNodeSchema,
  transferStageSchema,
  type SetupAckMsg,
  type SetupCreateInput,
  type SetupEventMsg,
  type SetupInfo,
  type SetupLogMsg,
  type SetupPatchInput,
  type SetupStatus,
  type SetupTransfer,
  type SetupValidateResultMsg,
  type SseEvent,
  type TransferStage,
} from "@irori/core";
import { nodes, setupRuns, setups, setupTransfers, type Db, type NodeRecord } from "@irori/db";
import type { Rings } from "./rings.js";
import type { SseHub } from "./sse.js";
import type { JobsService } from "./jobs-service.js";
import { readBodyRetention } from "./usage-retention.js";

/**
 * Serving setups (M5, SPEC §7): CRUD + start/stop orchestration through the
 * head agent's supervision driver, health derived from the node's LLM probe,
 * and staged model transfers that chain M4 jobs with parsed rsync progress.
 */

export class SetupNotFoundError extends Error {}
export class SetupBusyError extends Error {}
export class SetupOfflineError extends Error {}
export class SetupStartError extends Error {}
export class SetupInvalidError extends Error {}

export type TransferStageStatus = TransferStage["status"];

export type TransferInfo = SetupTransfer;

export interface SetupsService {
  list(): Promise<SetupInfo[]>;
  get(id: string): Promise<SetupInfo | null>;
  create(input: SetupCreateInput): Promise<SetupInfo>;
  patch(id: string, patch: SetupPatchInput): Promise<SetupInfo>;
  remove(id: string): Promise<void>;
  start(id: string): Promise<SetupInfo>;
  stop(id: string): Promise<SetupInfo>;
  onDriverAck(msg: SetupAckMsg, senderNodeId: string): Promise<void>;
  /** Create-time `test -x` validation on the head agent (10 s timeout). */
  validateScripts(nodeId: string, scripts: string[]): Promise<Array<{ script: string; ok: boolean; error: string | null }>>;
  onValidateResult(msg: SetupValidateResultMsg, senderNodeId: string): void;
  onDriverEvent(msg: SetupEventMsg, senderNodeId: string): Promise<void>;
  onDriverLog(msg: SetupLogMsg, senderNodeId: string): Promise<void>;
  /** Per-setup log SSE: replays the ring, then streams live lines. */
  attachLog(res: Response, setupId: string): void;
  /** Periodic driver-truth poll + health evaluation; call on an interval. */
  tick(): Promise<void>;
  transfers(setupId: string): Promise<TransferInfo[]>;
  createTransfer(setupId: string, targetNodeIds: string[]): Promise<TransferInfo>;
  cancelTransfer(transferId: string): Promise<boolean>;
  onJobOutput(nodeId: string, jobId: string, seq: number, line: string): Promise<void>;
  onJobDone(nodeId: string, jobId: string, status: string, exitCode: number | null): Promise<void>;
  /** Re-attaches transfers that were running when the server restarted. */
  recover(): Promise<void>;
}

export interface SetupsServiceDeps {
  db: Db;
  rings: Rings;
  sse: Pick<SseHub, "send">;
  getNode: (id: string) => Promise<NodeRecord | null>;
  getNodes: () => Promise<NodeRecord[]>;
  online: () => ReadonlySet<string>;
  sendToNode: (nodeId: string, msg: unknown) => boolean;
  refreshNodeConfig: (nodeId: string) => Promise<boolean>;
  jobs: Pick<JobsService, "create" | "cancel" | "findModel" | "presentNodesFor">;
  log?: (message: string) => void;
}

const ACK_TIMEOUT_MS = 15_000;
/** Stop ack: the agent waits gracefulMs + 30 s for the stop script, then the
 *  recorded-group fallback — the ack must outlive both. */
const STOP_ACK_TIMEOUT_MS = 75_000;
const LOG_RING_LINES = 1000;
const PROGRESS_EMIT_MS = 1_000;
const DRIVER_POLL_EVERY = 3; // ticks

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function shortName(model: string): string {
  const last = model.split("/").pop() ?? model;
  return last.length > 0 ? last : model;
}

function toNodes(raw: unknown): Array<{ nodeId: string; role: "worker" }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = setupNodeSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function toStages(raw: unknown): TransferStage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = transferStageSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function createSetupsService(deps: SetupsServiceDeps): SetupsService {
  const toInfo = (row: typeof setups.$inferSelect): SetupInfo =>
    setupInfoSchema.parse({
      id: row.id,
      name: row.name,
      kind: row.kind === "cluster" ? "cluster" : "single",
      model: row.model,
      port: row.port,
      headNodeId: row.headNodeId,
      nodes: toNodes(row.nodes),
      scriptStart: row.scriptStart,
      scriptStop: row.scriptStop,
      env: envExportsSchema.parse(row.env),
      captureProxy: row.captureProxy === true,
      bodyRetention: row.bodyRetention === true,
      status: row.status,
      health: row.health,
      lastError: row.lastError,
      startupTimeoutMs: row.startupTimeoutMs,
      lastStartedAt: iso(row.lastStartedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });

  // Pending start/stop acks from the head agent.
  const pending = new Map<string, { resolve: (r: { ok: boolean; error: string | null }) => void; timer: NodeJS.Timeout }>();
  const settleAck = (setupId: string, ok: boolean, error: string | null): boolean => {
    const entry = pending.get(setupId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(setupId);
    entry.resolve({ ok, error });
    return true;
  };

  // Pending create-time script validations. The expected sender is recorded
  // so a rogue agent cannot resolve another node's validation.
  const pendingValidate = new Map<
    string,
    { resolve: (r: Array<{ script: string; ok: boolean; error: string | null }>) => void; timer: NodeJS.Timeout; nodeId: string }
  >();

  const updateRow = async (id: string, patch: Partial<typeof setups.$inferInsert>): Promise<void> => {
    await deps.db.update(setups).set({ ...patch, updatedAt: new Date() }).where(eq(setups.id, id));
  };

  // setupId → headNodeId cache. headNodeId is immutable post-create and setup
  // frames are frequent (per log line), so avoid a DB read per frame.
  const headBySetup = new Map<string, string>();
  const headOf = async (setupId: string): Promise<string | null> => {
    const cached = headBySetup.get(setupId);
    if (cached !== undefined) return cached;
    const [row] = await deps.db
      .select({ head: setups.headNodeId })
      .from(setups)
      .where(eq(setups.id, setupId))
      .limit(1);
    if (!row) return null;
    headBySetup.set(setupId, row.head);
    return row.head;
  };

  // Per-setup log rings (memory; the agent's run log file is the durable copy).
  const logRings = new Map<string, Array<{ seq: number; line: string; ts: number }>>();
  const logClients = new Map<string, Set<Response>>();

  const pushLog = (setupId: string, seq: number, line: string, ts: number): void => {
    const ring = logRings.get(setupId) ?? [];
    ring.push({ seq, line, ts });
    if (ring.length > LOG_RING_LINES) ring.splice(0, ring.length - LOG_RING_LINES);
    logRings.set(setupId, ring);
    for (const res of logClients.get(setupId) ?? []) {
      try {
        res.write(`data: ${JSON.stringify({ seq, line, ts })}\n\n`);
      } catch {
        // Client vanished; the close handler removes it.
      }
    }
  };

  // IR-124: engine output also enters the shared feed, throttled to ≤1 frame
  // per second per setup with identical consecutive lines skipped — the same
  // live-only tradeoff as job-progress (a freshly opened drawer waits for the
  // next line; GET /api/v1/setups/:id/log remains the backfill source).
  const feedLogState = new Map<string, { lastLine: string; lastMs: number }>();
  const nameBySetup = new Map<string, string>();
  const nameOf = async (setupId: string): Promise<string | null> => {
    const cached = nameBySetup.get(setupId);
    if (cached !== undefined) return cached;
    const [row] = await deps.db.select({ name: setups.name }).from(setups).where(eq(setups.id, setupId)).limit(1);
    if (!row) return null;
    nameBySetup.set(setupId, row.name);
    return row.name;
  };
  const emitSharedSetupLog = (setupId: string, nodeId: string, line: string): void => {
    void nameOf(setupId).then((name) => {
      if (name === null) return;
      const st = feedLogState.get(setupId);
      const nowMs = Date.now();
      if (st !== undefined && (st.lastLine === line || nowMs - st.lastMs < 1000)) return;
      feedLogState.set(setupId, { lastLine: line, lastMs: nowMs });
      deps.sse.send({ type: "setup-log", serverTimeMs: nowMs, setupId, nodeId, name, line } satisfies SseEvent);
    });
  };

  const announce = (setupId: string, status: SetupStatus, health: SetupInfo["health"], lastError: string | null): void => {
    deps.sse.send({ type: "setup-state", serverTimeMs: Date.now(), setupId, status, health, lastError } satisfies SseEvent);
  };

  // Active transfers: transferId → live state; jobId → [transferId, stageIndex].
  const liveTransfers = new Map<string, { stages: TransferStage[]; setupId: string }>();
  const stageByJob = new Map<string, { transferId: string; index: number }>();
  const stageWaiters = new Map<string, { resolve: (status: string) => void }>();
  const lastProgressEmit = new Map<string, number>();
  let tickCount = 0;

  const persistStages = async (transferId: string, stages: TransferStage[], status: TransferInfo["status"], finished: boolean): Promise<void> => {
    await deps.db
      .update(setupTransfers)
      .set({ stages: stages as unknown, status, ...(finished ? { finishedAt: new Date() } : {}) })
      .where(eq(setupTransfers.id, transferId));
  };

  const emitStage = (transferId: string, setupId: string, stages: TransferStage[], index: number): void => {
    const stage = stages[index]!;
    deps.sse.send({
      type: "setup-transfer",
      serverTimeMs: Date.now(),
      setupId,
      transferId,
      stageIndex: index,
      stageCount: stages.length,
      label: stage.label,
      nodeId: stage.nodeId,
      jobId: stage.jobId,
      status: stage.status,
      progress: stage.progress,
    } satisfies SseEvent);
  };

  const runStages = async (transferId: string, setupId: string, stages: TransferStage[], from: number): Promise<void> => {
    const finalize = async (): Promise<void> => {
      const finalStatus: TransferInfo["status"] = stages.some((s) => s.status === "canceled")
        ? "canceled"
        : stages.some((s) => s.status === "failed")
          ? "failed"
          : "succeeded";
      await persistStages(transferId, stages, finalStatus, true);
      liveTransfers.delete(transferId);
    };
    for (let i = from; i < stages.length; i++) {
      const stage = stages[i]!;
      if (stage.status !== "pending") continue;
      let jobId: string;
      try {
        jobId = (await deps.jobs.create(stage.nodeId, stage.kind, stage.params)).id;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stage.status = "failed";
        stage.error = message.includes("active job") ? "busy: a job is already running on this node" : message;
        emitStage(transferId, setupId, stages, i);
        deps.log?.(`transfer ${transferId} stage ${i} failed: ${stage.error}`);
        // Same per-target semantics as a failed stage below: only the failed
        // target's own chain is skipped; other targets keep running.
        for (let j = i + 1; j < stages.length; j++) {
          const later = stages[j]!;
          if (later.status === "pending" && later.targetId !== null && later.targetId === stage.targetId) {
            later.status = "skipped";
          }
        }
        if (stages.every((s) => s.status !== "pending")) break;
        continue;
      }
      // Register the completion waiter before any await: a fast agent can
      // deliver job-done while we are still persisting the stage.
      stage.jobId = jobId;
      stage.status = "running";
      stageByJob.set(jobId, { transferId, index: i });
      const { promise: outcome, resolve: settle } = Promise.withResolvers<string>();
      stageWaiters.set(jobId, { resolve: settle });
      emitStage(transferId, setupId, stages, i);
      await persistStages(transferId, stages, "running", false);
      deps.log?.(`transfer ${transferId} stage ${i}: job ${jobId} (${stage.kind} on ${stage.nodeId})`);

      const result = await outcome;
      stageByJob.delete(jobId);
      stageWaiters.delete(jobId);
      stage.status = result === "succeeded" ? "succeeded" : result === "canceled" ? "canceled" : "failed";
      if (stage.status === "failed" && stage.error === null) stage.error = "transfer job failed";
      emitStage(transferId, setupId, stages, i);
      if (stage.status === "succeeded") continue;

      // A failed/canceled stage stops ITS target's chain — later stages for
      // the same target depend on it; other targets are unaffected.
      for (let j = i + 1; j < stages.length; j++) {
        const later = stages[j]!;
        if (later.status === "pending" && later.targetId !== null && later.targetId === stage.targetId) {
          later.status = "skipped";
        }
      }
      // Finalize only when nothing is left to run anywhere.
      if (stages.every((s) => s.status !== "pending")) break;
    }
    await finalize();
  };

  const latestPortSnap = (nodeId: string, port: number): { model: string | null; detected: boolean } | null => {
    const entry = deps.rings.latestLlm(nodeId);
    const snap = entry?.ports.find((p) => p.port === port);
    return snap ? { model: snap.model, detected: snap.detected } : null;
  };

  /**
   * Worker rows must reference real spark nodes — not the head itself, not a
   * NAS node, no duplicates. Nothing validated this once and a row shipped
   * with DGX-3 x4 plus the NAS listed twice as a worker.
   */
  const validateWorkers = async (
    workers: Array<{ nodeId: string; role: "worker" }>,
    headNodeId: string,
  ): Promise<void> => {
    const known = new Map((await deps.getNodes()).map((n) => [n.id, n]));
    const seen = new Set<string>();
    for (const worker of workers) {
      if (seen.has(worker.nodeId)) throw new SetupInvalidError(`duplicate worker node ${worker.nodeId}`);
      seen.add(worker.nodeId);
      if (worker.nodeId === headNodeId) throw new SetupInvalidError("the head cannot be its own worker");
      const row = known.get(worker.nodeId);
      if (row === undefined) throw new SetupInvalidError(`unknown worker node ${worker.nodeId}`);
      if (row.kind === "nas") throw new SetupInvalidError(`${row.name} is a NAS node and cannot be a worker`);
    }
  };

  const ensurePortAssigned = async (headNodeId: string, port: number): Promise<void> => {
    const [row] = await deps.db.select().from(nodes).where(eq(nodes.id, headNodeId)).limit(1);
    if (!row) return;
    const current = Array.isArray(row.llmPorts) ? (row.llmPorts as Array<{ port: number } | number>) : [];
    const ports = current.map((p) => (typeof p === "number" ? p : p.port));
    if (ports.includes(port)) return;
    await deps.db
      .update(nodes)
      .set({ llmPorts: [...ports, port].map((p) => ({ port: p, host: "127.0.0.1" })), updatedAt: new Date() })
      .where(eq(nodes.id, headNodeId));
    await deps.refreshNodeConfig(headNodeId);
  };

  const evaluateHealth = async (row: typeof setups.$inferSelect): Promise<void> => {
    const snap = latestPortSnap(row.headNodeId, row.port);
    let health = row.health;
    let status: SetupStatus = row.status;
    let lastError = row.lastError;
    if (snap?.detected === true && modelIdMatches(snap.model, row.model)) {
      health = "healthy";
      status = "running";
      lastError = null;
    } else if (snap?.detected === true) {
      health = "foreign";
      status = "running";
    } else if (row.health === "healthy") {
      // The engine stopped answering (crash, manual kill): demote until it
      // answers again — the probe is the source of truth for health.
      health = "timeout";
      if (lastError === null) lastError = `engine stopped answering on port ${row.port}`;
    } else if (row.lastStartedAt !== null && Date.now() - row.lastStartedAt.getTime() > row.startupTimeoutMs) {
      health = "timeout";
      if (lastError === null) {
        lastError = `startup timeout: nothing healthy on port ${row.port} after ${Math.round(row.startupTimeoutMs / 60_000)} min`;
      }
    }
    if (health === row.health && status === row.status && lastError === row.lastError) return;
    await updateRow(row.id, { health, status, lastError });
    announce(row.id, status, health, lastError);
  };

  return {
    async list() {
      const rows = await deps.db.select().from(setups).orderBy(setups.createdAt);
      return rows.map(toInfo);
    },

    async get(id) {
      const [row] = await deps.db.select().from(setups).where(eq(setups.id, id)).limit(1);
      return row ? toInfo(row) : null;
    },

    async create(input) {
      await validateWorkers(input.nodes, input.headNodeId);
      const [row] = await deps.db
        .insert(setups)
        .values({
          name: input.name,
          kind: input.kind,
          model: input.model,
          port: input.port,
          headNodeId: input.headNodeId,
          nodes: input.nodes,
          scriptStart: input.scriptStart,
          scriptStop: input.scriptStop,
          env: input.env,
          captureProxy: input.captureProxy,
          bodyRetention: input.bodyRetention,
        })
        .returning();
      if (!row) throw new Error("setup insert returned no row");
      nameBySetup.set(row.id, row.name);
      // The head's LLM probe must watch the script-defined port from now on.
      await ensurePortAssigned(row.headNodeId, row.port);
      return toInfo(row);
    },

    async patch(id, patch) {
      const [row] = await deps.db.select().from(setups).where(eq(setups.id, id)).limit(1);
      if (!row) throw new SetupNotFoundError("setup not found");
      if (patch.nodes !== undefined) await validateWorkers(patch.nodes, row.headNodeId);
      if (patch.name !== undefined) nameBySetup.set(id, patch.name);
      await updateRow(id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.port !== undefined ? { port: patch.port } : {}),
        ...(patch.nodes !== undefined ? { nodes: patch.nodes } : {}),
        ...(patch.scriptStart !== undefined ? { scriptStart: patch.scriptStart } : {}),
        ...(patch.scriptStop !== undefined ? { scriptStop: patch.scriptStop } : {}),
        ...(patch.env !== undefined ? { env: patch.env } : {}),
        ...(patch.captureProxy !== undefined ? { captureProxy: patch.captureProxy } : {}),
        ...(patch.bodyRetention !== undefined ? { bodyRetention: patch.bodyRetention } : {}),
      });
      if (patch.port !== undefined && patch.port !== row.port) {
        await ensurePortAssigned(row.headNodeId, patch.port);
      }
      const [updated] = await deps.db.select().from(setups).where(eq(setups.id, id)).limit(1);
      return toInfo(updated!);
    },

    async remove(id) {
      const [row] = await deps.db.select().from(setups).where(eq(setups.id, id)).limit(1);
      if (!row) throw new SetupNotFoundError("setup not found");
      if (row.status === "starting" || row.status === "running" || row.status === "stopping") {
        throw new SetupBusyError("stop the setup before removing it");
      }
      await deps.db.delete(setups).where(eq(setups.id, id));
      headBySetup.delete(id);
    },

    async start(id) {
      const [row] = await deps.db.select().from(setups).where(eq(setups.id, id)).limit(1);
      if (!row) throw new SetupNotFoundError("setup not found");
      if (row.status === "starting" || row.status === "running" || row.status === "stopping") {
        throw new SetupBusyError(`setup is ${row.status}`);
      }
      if (!deps.online().has(row.headNodeId)) throw new SetupOfflineError("head node agent is offline");

      const envCfg = envExportsSchema.parse(row.env);
      // Refuse fast: a MODEL_PATH start resolves on the head's local store via
      // `modelctl path --local`; when the model was never staged there the
      // agent refuses after we already recorded a run row. Check here instead
      // — staging stays the explicit "Stage transfers" action.
      if (envCfg.modelPath) {
        const staged = new Set(await deps.jobs.presentNodesFor(row.model));
        if (!staged.has(row.headNodeId)) {
          const head = await deps.getNode(row.headNodeId);
          throw new SetupStartError(
            `${shortName(row.model)} is not staged on ${head?.name ?? "the head node"} — stage transfers first, then start`,
          );
        }
      }
      const env: Record<string, string> = {};
      if (envCfg.modelName) env.MODEL_NAME = row.model;
      // ADR-0008 §7: captured setups get the agent-chosen loopback engine
      // port injected agent-side ($PORT contract) — the server cannot know a
      // node-local free port, so it omits PORT here.
      if (envCfg.port && row.captureProxy !== true) env.PORT = String(row.port);
      if (envCfg.extraArgs.length > 0) env.EXTRA_ARGS = envCfg.extraArgs;

      await ensurePortAssigned(row.headNodeId, row.port);

      const runId = randomUUID();
      await deps.db.insert(setupRuns).values({ id: runId, setupId: row.id, status: "running" });
      const sent = deps.sendToNode(row.headNodeId, {
        type: "setup-start",
        setupId: row.id,
        runId,
        scriptStart: row.scriptStart,
        scriptStop: row.scriptStop,
        env,
        modelPathName: envCfg.modelPath ? row.model : null,
        capture:
          row.captureProxy === true
            ? { proxyPort: row.port, retention: row.bodyRetention === true ? await readBodyRetention(deps.db) : null }
            : null,
      });
      if (!sent) {
        await deps.db.update(setupRuns).set({ status: "failed", endedAt: new Date() }).where(eq(setupRuns.id, runId));
        await updateRow(row.id, { status: "failed", lastError: "head agent is not connected" });
        throw new SetupOfflineError("head agent is not connected");
      }

      const { promise, resolve } = Promise.withResolvers<{ ok: boolean; error: string | null }>();
      const timer = setTimeout(() => {
        pending.delete(row.id);
        resolve({ ok: false, error: "head agent did not acknowledge the start" });
      }, ACK_TIMEOUT_MS);
      pending.set(row.id, { resolve, timer });
      const ack = await promise;

      if (!ack.ok) {
        await deps.db.update(setupRuns).set({ status: "failed", endedAt: new Date() }).where(eq(setupRuns.id, runId));
        await updateRow(row.id, { status: "failed", lastError: ack.error ?? "start refused" });
        throw new SetupStartError(ack.error ?? "start refused");
      }
      await updateRow(row.id, { status: "starting", health: "starting", lastError: null, lastStartedAt: new Date() });
      announce(row.id, "starting", "starting", null);
      const [updated] = await deps.db.select().from(setups).where(eq(setups.id, id)).limit(1);
      return toInfo(updated!);
    },

    async stop(id) {
      const [row] = await deps.db.select().from(setups).where(eq(setups.id, id)).limit(1);
      if (!row) throw new SetupNotFoundError("setup not found");
      if (row.status === "stopped") return toInfo(row);
      if (!deps.online().has(row.headNodeId)) throw new SetupOfflineError("head node agent is offline");

      // 20 s: the agent's fallback deadline for the recorded group; the stop
      // script itself gets +30 s on top (see SetupDriver.stop). The pending
      // ack slot is registered BEFORE the frame goes out — a fast agent can
      // answer within the updateRow await below.
      const { promise, resolve } = Promise.withResolvers<{ ok: boolean; error: string | null }>();
      const timer = setTimeout(() => {
        pending.delete(row.id);
        resolve({ ok: false, error: "head agent did not acknowledge the stop" });
      }, STOP_ACK_TIMEOUT_MS);
      pending.set(row.id, { resolve, timer });

      const sent = deps.sendToNode(row.headNodeId, { type: "setup-stop", setupId: row.id, gracefulMs: 20_000 });
      if (!sent) {
        settleAck(row.id, false, "head agent is not connected");
        throw new SetupOfflineError("head agent is not connected");
      }

      await updateRow(id, { status: "stopping" });
      const ack = await promise;

      await updateRow(id, { status: "stopped", health: null, lastError: ack.ok ? null : (ack.error ?? "stop failed") });
      const [latest] = await deps.db
        .select({ id: setupRuns.id })
        .from(setupRuns)
        .where(and(eq(setupRuns.setupId, row.id), eq(setupRuns.status, "running")))
        .orderBy(desc(setupRuns.startedAt))
        .limit(1);
      if (latest) {
        await deps.db.update(setupRuns).set({ status: "stopped", endedAt: new Date() }).where(eq(setupRuns.id, latest.id));
      }
      announce(row.id, "stopped", null, ack.ok ? null : (ack.error ?? "stop failed"));
      const [updated] = await deps.db.select().from(setups).where(eq(setups.id, id)).limit(1);
      return toInfo(updated!);
    },

    async onDriverAck(msg, senderNodeId) {
      const head = await headOf(msg.setupId);
      if (head === null || head !== senderNodeId) return;
      settleAck(msg.setupId, msg.ok, msg.error ?? null);
    },

    async validateScripts(nodeId, scripts) {
      if (!deps.online().has(nodeId)) throw new SetupOfflineError("node agent is offline");
      const validateId = randomUUID();
      const sent = deps.sendToNode(nodeId, { type: "setup-validate", validateId, scripts });
      if (!sent) throw new SetupOfflineError("node agent is not connected");
      const { promise, resolve } = Promise.withResolvers<Array<{ script: string; ok: boolean; error: string | null }>>();
      const timer = setTimeout(() => {
        pendingValidate.delete(validateId);
        resolve(scripts.map((script) => ({ script, ok: false, error: "agent did not answer the validation" })));
      }, 10_000);
      pendingValidate.set(validateId, { resolve, timer, nodeId });
      return promise;
    },

    onValidateResult(msg, senderNodeId) {
      const entry = pendingValidate.get(msg.validateId);
      if (!entry || entry.nodeId !== senderNodeId) return;
      clearTimeout(entry.timer);
      pendingValidate.delete(msg.validateId);
      entry.resolve(msg.results.map((r) => ({ script: r.script, ok: r.ok, error: r.error ?? null })));
    },

    async onDriverEvent(msg, senderNodeId) {
      const [row] = await deps.db.select().from(setups).where(eq(setups.id, msg.setupId)).limit(1);
      if (!row) return;
      if (row.headNodeId !== senderNodeId) return;
      headBySetup.set(row.id, row.headNodeId);

      if (msg.runId !== null) {
        const runStatus = msg.state === "failed" ? "failed" : msg.state === "stopped" ? "stopped" : "running";
        await deps.db
          .update(setupRuns)
          .set({ status: runStatus, exitCode: msg.exitCode, pid: msg.pid, pgid: msg.pgid })
          .where(eq(setupRuns.id, msg.runId));
      }

      // While a stop is settling, stop() owns the final state — a late
      // "stopping" event must not overwrite the settled "stopped". Only a
      // "stopped" event settles it (also heals an ack lost to a server
      // restart mid-stop).
      if (row.status === "stopping") {
        if (msg.state !== "stopped") return;
        await updateRow(row.id, { status: "stopped", health: null });
        announce(row.id, "stopped", null, row.lastError);
        return;
      }

      let status: SetupStatus = row.status;
      let health = row.health;
      switch (msg.state) {
        case "starting":
          status = "starting";
          break;
        case "running":
          status = health === "healthy" ? "running" : "starting";
          break;
        case "stopped": {
          // The start script completed on its own or a poll reported: only a
          // start's own exit (exitCode set) may promote via the probe.
          if (msg.exitCode !== null) {
            const snap = latestPortSnap(row.headNodeId, row.port);
            if (snap !== null && snap.detected && modelIdMatches(snap.model, row.model)) {
              status = "running";
              health = "healthy";
            } else {
              status = "stopped";
              health = null;
            }
          } else {
            // Poll truth or stop completion: the driver is gone and nothing
            // may resurrect the setup — polls never promote via the probe.
            status = "stopped";
            health = null;
          }
          break;
        }
        case "failed":
          status = "failed";
          break;
      }
      const lastError = msg.error ?? (status === "failed" ? "driver reported failure" : row.lastError);
      // Driver-truth polls repeat every 15 s; re-announcing an unchanged state
      // floods the feed with identical lines (and rewrites the row for nothing).
      if (status === row.status && health === row.health && lastError === row.lastError) return;
      await updateRow(row.id, { status, health, lastError });
      announce(row.id, status, health, lastError);
    },

    async onDriverLog(msg, senderNodeId) {
      const head = await headOf(msg.setupId);
      if (head === null || head !== senderNodeId) return;
      pushLog(msg.setupId, msg.seq, msg.line, msg.ts);
      emitSharedSetupLog(msg.setupId, head, msg.line);
    },

    attachLog(res, setupId) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      for (const entry of logRings.get(setupId) ?? []) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
      const clients = logClients.get(setupId) ?? new Set();
      clients.add(res);
      logClients.set(setupId, clients);
      res.on("close", () => clients.delete(res));
    },

    async tick() {
      tickCount++;
      const online = deps.online();
      const rows = await deps.db.select().from(setups);
      for (const row of rows) {
        if (!online.has(row.headNodeId)) continue;
        if (row.status === "starting" || row.status === "running") {
          await evaluateHealth(row);
        }
        // Driver-truth poll: heals drift after agent/server restarts.
        if (tickCount % DRIVER_POLL_EVERY === 0) {
          deps.sendToNode(row.headNodeId, { type: "setup-status", setupId: row.id });
        }
      }
    },

    async transfers(setupId) {
      const rows = await deps.db
        .select()
        .from(setupTransfers)
        .where(eq(setupTransfers.setupId, setupId))
        .orderBy(desc(setupTransfers.createdAt))
        .limit(20);
      return rows.map((row) => ({
        id: row.id,
        setupId: row.setupId,
        status: row.status as TransferInfo["status"],
        stages: toStages(row.stages),
        createdAt: row.createdAt.toISOString(),
        finishedAt: iso(row.finishedAt),
      }));
    },

    async createTransfer(setupId, targetNodeIds) {
      const [row] = await deps.db.select().from(setups).where(eq(setups.id, setupId)).limit(1);
      if (!row) throw new SetupNotFoundError("setup not found");
      if (targetNodeIds.length === 0) throw new Error("no target nodes given");

      const modelEntry = await deps.jobs.findModel(row.model);
      const holderIds = new Set(await deps.jobs.presentNodesFor(row.model));
      const allNodes = await deps.getNodes();
      const byId = new Map(allNodes.map((n) => [n.id, n]));
      // Same NAS-first store policy as the download queue (IRI-014); the
      // transfer stages run later, so no online filter here.
      const nasNode = pickStoreNode(allNodes);
      const online = deps.online();

      const stages: TransferStage[] = [];
      const pushStage = (label: string, targetId: string | null, nodeId: string, kind: string, params: Record<string, unknown>): void => {
        stages.push({ label, targetId, nodeId, kind, params, jobId: null, status: "pending", progress: null, error: null });
      };

      // Pass 1: NAS-mounting targets sync from the store; they become push
      // sources for pass 2 (the staged NAS→head→worker chain). Sync on the
      // store node itself is a local disk copy and always stays. Every other
      // NAS-mounting target defers to pass 2 when a reachable node already
      // holds the model locally — the CX7 push beats the SMB store hop
      // (IR-100, same policy as planPlacement).
      const nasTargets: string[] = [];
      for (const targetId of targetNodeIds) {
        const target = byId.get(targetId);
        if (target && !holderIds.has(targetId) && modelEntry !== null && target.nasRoot !== null) {
          const holderReachable =
            targetId !== nasNode?.id &&
            allNodes.some((n) => holderIds.has(n.id) && n.id !== targetId && n.enabled && online.has(n.id));
          if (holderReachable) continue;
          pushStage(`NAS → ${target.name} (sync)`, targetId, targetId, "sync-local", { name: row.model });
          nasTargets.push(targetId);
        }
      }
      // Pass 2: everything else pushes from a holder — a node that already
      // holds the model, or a NAS-mounting target planned above (it will hold
      // it once its sync completes). Last resort: a direct HF download.
      for (const targetId of targetNodeIds) {
        const target = byId.get(targetId);
        if (!target) {
          pushStage("unknown node", targetId, targetId, "noop", {});
          const last = stages[stages.length - 1]!;
          last.status = "skipped";
          last.error = "node not found";
          continue;
        }
        if (holderIds.has(targetId) || nasTargets.includes(targetId)) continue; // covered

        const source =
          allNodes.find((n) => holderIds.has(n.id) && n.id !== targetId && n.enabled && online.has(n.id)) ??
          allNodes.find((n) => nasTargets.includes(n.id) && n.enabled && online.has(n.id));
        if (source !== undefined) {
          // IR-101: dial the destination's cache user so the remote receive
          // lands in that user's HF cache (modelctl ssh user == cache owner).
          pushStage(`${source.name} → ${target.name} (push)`, targetId, source.id, "push", {
            name: row.model,
            hosts: [target.cacheUser ? `${target.cacheUser}@${target.host}` : target.host],
            jobs: 4,
          });
          continue;
        }
        if (modelEntry === null) {
          // Not in the store: chain the HF download (wizard's "chained HF
          // download when the NAS lacks it").
          if (nasNode !== null && nasNode.id !== targetId) {
            pushStage(`HF → ${nasNode.name} (download)`, targetId, nasNode.id, "download-queue", {
              downloads: [{ source: row.model, name: shortName(row.model) }],
              jobs: 4,
            });
            if (target.nasRoot !== null) {
              pushStage(`NAS → ${target.name} (sync)`, targetId, targetId, "sync-local", { name: shortName(row.model) });
              continue;
            }
          }
          pushStage(`HF → ${target.name} (download)`, targetId, targetId, "download", { name: row.model });
          continue;
        }
        pushStage(`HF → ${target.name} (download)`, targetId, targetId, "download", { name: row.model });
      }

      const transferId = randomUUID();
      const now = new Date().toISOString();
      if (stages.length === 0) {
        await deps.db.insert(setupTransfers).values({ id: transferId, setupId, stages: [], status: "succeeded", finishedAt: new Date() });
        return { id: transferId, setupId, status: "succeeded", stages: [], createdAt: now, finishedAt: now };
      }
      await deps.db.insert(setupTransfers).values({ id: transferId, setupId, stages: stages as unknown, status: "running" });
      liveTransfers.set(transferId, { stages, setupId });
      void runStages(transferId, setupId, stages, 0);
      return { id: transferId, setupId, status: "running", stages, createdAt: now, finishedAt: null };
    },

    async cancelTransfer(transferId) {
      const live = [...liveTransfers.entries()].find(([id]) => id === transferId);
      if (!live) return false;
      const [, state] = live;
      const running = state.stages.find((s) => s.status === "running" && s.jobId !== null);
      if (running?.jobId) await deps.jobs.cancel(running.jobId);
      // The stage waiter resolves "canceled" via onJobDone.
      return true;
    },

    async onJobOutput(nodeId, jobId, seq, line) {
      void nodeId;
      void seq;
      const ref = stageByJob.get(jobId);
      if (!ref) return;
      const progress = parseTransferProgress(line);
      if (progress === null) return;
      const live = liveTransfers.get(ref.transferId);
      if (!live) return;
      live.stages[ref.index]!.progress = progress;
      const now = Date.now();
      const last = lastProgressEmit.get(ref.transferId) ?? 0;
      if (now - last < PROGRESS_EMIT_MS) return;
      lastProgressEmit.set(ref.transferId, now);
      emitStage(ref.transferId, live.setupId, live.stages, ref.index);
    },

    async onJobDone(nodeId, jobId, status, exitCode) {
      void nodeId;
      void exitCode;
      // Transfer stages first (the waiter chains the next stage), then the
      // generic stage bookkeeping for transfers that were recovered.
      const waiter = stageWaiters.get(jobId);
      if (waiter) {
        waiter.resolve(status);
        return;
      }
      const ref = stageByJob.get(jobId);
      if (ref) {
        const live = liveTransfers.get(ref.transferId);
        if (live) {
          live.stages[ref.index]!.status = status as TransferStageStatus;
          emitStage(ref.transferId, live.setupId, live.stages, ref.index);
        }
        stageByJob.delete(jobId);
      }
    },

    async recover() {
      const rows = await deps.db.select().from(setupTransfers).where(inArray(setupTransfers.status, ["running"]));
      for (const row of rows) {
        const stages = toStages(row.stages);
        // A stage persisted `running` when the server died must be re-run:
        // leaving it running would skip it (findIndex starts after it) while
        // finalize() would still report the transfer `succeeded`.
        for (const stage of stages) {
          if (stage.status === "running") stage.status = "pending";
        }
        const resumeAt = stages.findIndex((s) => s.status === "pending" || s.status === "queued");
        if (resumeAt === -1) {
          await deps.db.update(setupTransfers).set({ status: "failed", finishedAt: new Date() }).where(eq(setupTransfers.id, row.id));
          continue;
        }
        stages[resumeAt]!.status = "pending";
        for (let i = resumeAt + 1; i < stages.length; i++) {
          if (stages[i]!.status === "queued" || stages[i]!.status === "running") stages[i]!.status = "pending";
        }
        liveTransfers.set(row.id, { stages, setupId: row.setupId });
        void runStages(row.id, row.setupId, stages, resumeAt);
      }
    },
  };
}
