import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { benchTypeSchema, nodeCreateSchema, nodeInfoSchema, nodePatchSchema, setupCreateSchema, setupPatchSchema, type NodeInfo } from "@irori/core";
import type { NodeRecord, NodeStore } from "@irori/db";
import { isHistoryRange, type HistoryResponse, type HistoryRange } from "./history.js";
import { type AnalyticsService } from "./analytics.js";
import { type CleanupService } from "./cleanup-service.js";
import { analyticsLensSchema, analyticsRangeSchema } from "@irori/core";
import { type LlmHistoryResponse } from "./llm-history.js";
import type { LlmStore } from "./llm-store.js";
import { nodeLlmAssignments } from "./llm-store.js";
import { JobBusyError, JobDispatchError, type JobsService } from "./jobs-service.js";
import { BenchBusyError, BenchNotFoundError, BenchOfflineError, type BenchRunRow, type BenchService } from "./bench-service.js";
import { planPlacement } from "@irori/core";
import type { Rings } from "./rings.js";
import type { SseHub } from "./sse.js";
import type { AgentHub } from "./hub.js";
import { SetupBusyError, SetupNotFoundError, SetupOfflineError, SetupStartError, type SetupsService } from "./setups-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_NODES_ONLINE: ReadonlySet<string> = new Set();
/** Upper bound on probe assignments accepted per node. */
const MAX_LLM_PORTS = 32;
/** Models-page page size (M1 Models v2 spec: 25/page). */
const MODELS_PAGE_SIZE = 25;
/** Placement reserve: keep this much disk free beyond the model itself. */
const DEFAULT_RESERVE_BYTES = 20 * 1024 ** 3;

/** Largest free space across the node's real mounts (the store disk wins). */
function maxDiskFree(snapshot: unknown): number | null {
  const storage = (snapshot as { storage?: Array<{ totalBytes: number; usedBytes: number }> } | null | undefined)?.storage;
  if (!Array.isArray(storage) || storage.length === 0) return null;
  let max = 0;
  for (const s of storage) {
    if (typeof s?.totalBytes !== "number" || typeof s?.usedBytes !== "number") continue;
    const free = s.totalBytes - s.usedBytes;
    if (free > max) max = free;
  }
  return max > 0 ? max : null;
}

function serializeJob(job: {
  id: string;
  nodeId: string;
  kind: string;
  status: string;
  params: unknown;
  exitCode: number | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}) {
  return {
    id: job.id,
    nodeId: job.nodeId,
    kind: job.kind,
    status: job.status,
    params: job.params,
    exitCode: job.exitCode,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** Builds a history response; null while degraded (no DB wired yet). */
export type HistoryBuilder = (nodeId: string, range: HistoryRange) => Promise<HistoryResponse>;

/** Builds an llm history response; null while degraded (no DB wired yet). */
export type LlmHistoryBuilder = (nodeId: string, range: HistoryRange) => Promise<LlmHistoryResponse>;

export interface AppDeps {
  /** Null while degraded (no/migrating DB): store-backed routes answer 503. */
  getStore: () => NodeStore | null;
  /** Null while degraded: history routes answer 503 and llm-ports writes fail. */
  getLlmStore: () => LlmStore | null;
  /** Null while degraded: the history routes answer 503. */
  getHistory: () => HistoryBuilder | null;
  getLlmHistory: () => LlmHistoryBuilder | null;
  /** Null while degraded: jobs routes answer 503. */
  getJobs: () => JobsService | null;
  /** Null while degraded: setups routes answer 503 (M5). */
  getSetups: () => SetupsService | null;
  /** Null while degraded: bench routes answer 503 (M6). */
  getBench: () => BenchService | null;
  /** Null while degraded: analytics routes answer 503 (M7). */
  getAnalytics: () => AnalyticsService | null;
  /** Null while degraded: cleanup routes answer 503 (M7). */
  getCleanup: () => CleanupService | null;
  dbHealthy: () => Promise<boolean>;
  rings: Rings;
  sse: SseHub;
  getHub: () => Pick<AgentHub, "online" | "sendToNode"> | null;
  version: string;
  /** apps/web/dist when it exists, else null. */
  staticDir: string | null;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  // Degraded mode (ADR-0002): while the store is absent, store-backed routes
  // answer 503 and nothing else in the API is affected.
  const requireStore = (res: Response): NodeStore | null => {
    const store = deps.getStore();
    if (store === null) res.status(503).json({ error: "database unavailable" });
    return store;
  };

  app.get("/healthz", async (_req, res) => {
    res.json({ ok: true, db: await deps.dbHealthy(), version: deps.version });
  });

  app.get("/api/v1/events", (_req, res) => {
    deps.sse.subscribe(res);
  });

  const onlineSet = (): ReadonlySet<string> => deps.getHub()?.online() ?? NO_NODES_ONLINE;

  app.get("/api/v1/nodes", async (_req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const online = onlineSet();
    res.json((await store.list()).map((row) => toNodeDto(row, online.has(row.id))));
  });

  app.post("/api/v1/nodes", async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const body = nodeCreateSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    const created = await store.create(body.data);
    const now = new Date().toISOString();
    const node = nodeInfoSchema.parse({
      id: created.id,
      name: body.data.name,
      kind: body.data.kind,
      role: body.data.role,
      host: body.data.host,
      enabled: body.data.enabled ?? true,
      agentVersion: null,
      online: false,
      lastSeenAt: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ node, token: created.token });
  });

  app.patch("/api/v1/nodes/:id", async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const body = nodePatchSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    // Defaults (llmPorts: []) must not wipe stored values when the key is
    // absent from the request — apply only the keys the client sent.
    const requested = typeof req.body === "object" && req.body !== null ? Object.keys(req.body) : [];
    const patch = Object.fromEntries(Object.entries(body.data).filter(([k]) => requested.includes(k)));
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    await store.patch(id, patch);
    const row = await store.get(id);
    if (row === null) return res.status(404).json({ error: "node not found" });
    res.json({ node: toNodeDto(row, onlineSet().has(id)) });
  });

  app.delete("/api/v1/nodes/:id", async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    await store.remove(id);
    deps.rings.remove(id);
    res.status(204).end();
  });

  app.post("/api/v1/nodes/:id/token/rotate", async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const created = await store.rotateToken(id);
    res.json({ token: created.token });
  });

  app.get("/api/v1/nodes/:id/snapshot", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const snapshot = deps.rings.latest(id);
    if (snapshot === undefined) return res.status(404).json({ error: "no snapshot available" });
    res.json(snapshot);
  });

  app.get("/api/v1/nodes/:id/history", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const range = req.query.range;
    if (typeof range !== "string" || !isHistoryRange(range)) {
      return res.status(400).json({ error: "unknown range" });
    }
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const build = deps.getHistory();
    if (build === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await build(id, range));
  });

  // ---- M7: analytics (SPEC §9) — five lenses over the rollup buckets ----
  app.get("/api/v1/analytics/:lens", async (req, res) => {
    const lens = analyticsLensSchema.safeParse(req.params.lens);
    if (!lens.success) return res.status(400).json({ error: "unknown lens" });
    const range = analyticsRangeSchema.safeParse(req.query.range);
    if (!range.success) return res.status(400).json({ error: "unknown range" });
    const rawGroup = req.query.groupBy;
    const groupBy = rawGroup === "cluster" || rawGroup === "node" ? rawGroup : "node";
    const setupId = typeof req.query.setupId === "string" ? req.query.setupId : undefined;
    const nodeId = typeof req.query.nodeId === "string" ? req.query.nodeId : undefined;
    const service = deps.getAnalytics();
    if (service === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await service.build({ lens: lens.data, range: range.data, groupBy, setupId, nodeId }));
  });

  // ---- M7: cleanup drawer (SPEC §11.6) ----
  app.get("/api/v1/nodes/:id/cleanup", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const service = deps.getCleanup();
    if (service === null) return res.status(503).json({ error: "database unavailable" });
    const [latestAudit, history, prevention] = await Promise.all([service.latestAudit(id), service.history(id), service.prevention(id)]);
    res.json({ latestAudit, history, prevention });
  });

  app.put("/api/v1/nodes/:id/hygiene", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const body = req.body as { weeklySafePass?: unknown } | null;
    if (body === null || typeof body !== "object" || typeof body.weeklySafePass !== "boolean" || Object.keys(body).length !== 1) {
      return res.status(400).json({ error: "body must be { weeklySafePass: boolean }" });
    }
    const service = deps.getCleanup();
    if (service === null) return res.status(503).json({ error: "database unavailable" });
    await service.setPrevention(id, { weeklySafePass: body.weeklySafePass });
    res.json(await service.prevention(id));
  });

  // Live llm probe view: in-memory ring first, latest persisted pass as
  // fallback (fresh boot, agent still to reconnect). 404 when nothing is known.
  app.get("/api/v1/nodes/:id/llm", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const entry = deps.rings.latestLlm(id);
    if (entry !== undefined) {
      return res.json({ ports: entry.ports, updatedAt: new Date(entry.serverTimeMs).toISOString() });
    }
    const llmStore = deps.getLlmStore();
    const fallback = llmStore === null ? null : await llmStore.latestLlmSnapshot(id);
    if (fallback === null) return res.status(404).json({ error: "no llm data available" });
    res.json({ ports: fallback.ports, updatedAt: new Date(fallback.serverTimeMs).toISOString() });
  });

  app.get("/api/v1/nodes/:id/llm/history", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const range = req.query.range;
    if (typeof range !== "string" || !isHistoryRange(range)) {
      return res.status(400).json({ error: "unknown range" });
    }
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const build = deps.getLlmHistory();
    if (build === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await build(id, range));
  });

  // Dedicated probe-assignment endpoint: nodePatchSchema (core, out of M3
  // scope) has no llmPorts yet — reported to Main. Body: { ports: number[] }.
  app.put("/api/v1/nodes/:id/llm-ports", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const ports = parsePortsBody(req.body);
    if (ports === null) return res.status(400).json({ error: "invalid request" });
    const llmStore = deps.getLlmStore();
    if (llmStore === null) return res.status(503).json({ error: "database unavailable" });
    await llmStore.setNodeLlmPorts(id, ports);
    const row = await store.get(id);
    res.json({ llmPorts: nodeLlmAssignments(row) });
  });

  // ---- M4: jobs, models, placement ----

  // Enqueue + dispatch a job to the node's agent (one active per node).
  app.post("/api/v1/nodes/:id/jobs", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const body = req.body as { kind?: unknown; params?: unknown };
    if (typeof body?.kind !== "string") return res.status(400).json({ error: "kind is required" });
    const params = (body.params ?? {}) as Record<string, unknown>;
    try {
      const job = await jobs.create(id, body.kind, params);
      res.status(202).json({ job: serializeJob(job) });
    } catch (err) {
      if (err instanceof JobBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof JobDispatchError) return res.status(409).json({ error: err.message });
      if (err instanceof Error && err.name === "ZodError") return res.status(400).json({ error: "unknown job kind" });
      throw err;
    }
  });

  app.get("/api/v1/jobs/:id", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid job id" });
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const job = await jobs.get(id);
    if (job === null) return res.status(404).json({ error: "job not found" });
    res.json({ job: serializeJob(job), output: job.output });
  });

  app.post("/api/v1/jobs/:id/cancel", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid job id" });
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const ok = await jobs.cancel(id);
    if (!ok) return res.status(409).json({ error: "job not cancelable" });
    res.status(204).end();
  });

  // NAS catalog listing from the model_meta cache (refreshed by catalog frames).
  app.get("/api/v1/models", async (req, res) => {
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const q = typeof req.query.q === "string" ? req.query.q.toLowerCase() : "";
    const page = Math.max(1, Number.parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10) || 1);
    const sort = req.query.sort === "name" ? "name" : "recent";
    const rows = sort === "name" ? await jobs.listModels() : await jobs.listModelsByRecent();
    const filtered = q.length === 0 ? rows : rows.filter((m) => m.name.toLowerCase().includes(q) || m.repository.toLowerCase().includes(q));
    const total = filtered.length;
    const models = filtered.slice((page - 1) * MODELS_PAGE_SIZE, page * MODELS_PAGE_SIZE).map((m) => ({
      ...m,
      firstSeenAt: m.firstSeenAt instanceof Date ? m.firstSeenAt.toISOString() : String(m.firstSeenAt ?? ""),
      updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : String(m.updatedAt ?? ""),
    }));
    res.json({ page, pageSize: MODELS_PAGE_SIZE, total, models });
  });

  // Ask model-ops agents to re-report their store catalog.
  app.post("/api/v1/models/refresh", async (_req, res) => {
    const hub = deps.getHub();
    const sent = hub === null ? 0 : [...hub.online()].filter((nodeId) => hub.sendToNode(nodeId, { type: "catalog-request" })).length;
    res.status(202).json({ requested: sent });
  });

  // Placement: model × every node → present|sync|push|unavailable.
  app.get("/api/v1/placement", async (req, res) => {
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const model = typeof req.query.model === "string" ? req.query.model : "";
    if (model.length === 0) return res.status(400).json({ error: "model is required" });
    const entry = await jobs.findModel(model);
    if (entry === null) return res.status(404).json({ error: "unknown model" });
    const store = requireStore(res);
    if (!store) return;
    const rows = await store.list();
    const online = deps.getHub()?.online() ?? NO_NODES_ONLINE;
    // Where the model exists: the NAS store (always — the catalog IS the store)
    // plus every node a succeeded transfer left it on.
    const presentNodeIds = await jobs.presentNodesFor(model);
    const availableOn = [{ nodeId: "nas", bytes: entry.bytes }, ...presentNodeIds.map((nodeId) => ({ nodeId, bytes: entry.bytes }))];
    const placements = [];
    for (const row of rows) {
      const snapshot = deps.rings.latest(row.id);
      const diskFreeBytes = maxDiskFree(snapshot);
      const target = {
        id: row.id,
        name: row.name,
        kind: row.kind,
        role: row.role,
        hasNasRoot: row.nasRoot !== null,
        pushCapable: online.has(row.id) && row.enabled,
        diskFreeBytes,
      };
      placements.push({
        node: { id: row.id, name: row.name, kind: row.kind, role: row.role, host: row.host, online: online.has(row.id) },
        ...planPlacement({
          availableOn,
          target,
          reserveBytes: DEFAULT_RESERVE_BYTES,
        }),
      });
    }
    res.json({ model: { name: entry.name, bytes: entry.bytes }, placements });
  });

  // ---- M5: setups (serving orchestration) ----

  const requireSetups = (res: Response): SetupsService | null => {
    const setups = deps.getSetups();
    if (setups === null) res.status(503).json({ error: "database unavailable" });
    return setups;
  };

  app.get("/api/v1/setups", async (_req, res) => {
    const setups = requireSetups(res);
    if (!setups) return;
    res.json({ setups: await setups.list() });
  });

  // Create-time script validation on the head agent (test -x; no side effects).
  app.post("/api/v1/setups/validate-scripts", async (req, res) => {
    const setups = requireSetups(res);
    if (!setups) return;
    const body = req.body as { nodeId?: unknown; scripts?: unknown };
    if (typeof body?.nodeId !== "string" || !Array.isArray(body.scripts) || body.scripts.some((s) => typeof s !== "string")) {
      return res.status(400).json({ error: "nodeId and scripts are required" });
    }
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(body.nodeId)) === null) return res.status(404).json({ error: "node not found" });
    try {
      const results = await setups.validateScripts(body.nodeId, body.scripts as string[]);
      res.json({ results });
    } catch (err) {
      if (err instanceof SetupOfflineError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  app.post("/api/v1/setups", async (req, res) => {
    const setups = requireSetups(res);
    if (!setups) return;
    const body = setupCreateSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(body.data.headNodeId)) === null) return res.status(400).json({ error: "unknown head node" });
    try {
      res.status(201).json({ setup: await setups.create(body.data) });
    } catch (err) {
      if (err instanceof SetupOfflineError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  app.get("/api/v1/setups/:id", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid setup id" });
    const setups = requireSetups(res);
    if (!setups) return;
    const setup = await setups.get(id);
    if (setup === null) return res.status(404).json({ error: "setup not found" });
    res.json({ setup, transfers: await setups.transfers(id) });
  });

  app.patch("/api/v1/setups/:id", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid setup id" });
    const setups = requireSetups(res);
    if (!setups) return;
    const body = setupPatchSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    try {
      res.json({ setup: await setups.patch(id, body.data) });
    } catch (err) {
      if (err instanceof SetupNotFoundError) return res.status(404).json({ error: err.message });
      throw err;
    }
  });

  app.delete("/api/v1/setups/:id", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid setup id" });
    const setups = requireSetups(res);
    if (!setups) return;
    try {
      await setups.remove(id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof SetupNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof SetupBusyError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  app.post("/api/v1/setups/:id/start", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid setup id" });
    const setups = requireSetups(res);
    if (!setups) return;
    try {
      const setup = await setups.start(id);
      res.status(202).json({ setup });
    } catch (err) {
      if (err instanceof SetupNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof SetupBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof SetupOfflineError) return res.status(409).json({ error: err.message });
      if (err instanceof SetupStartError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  app.post("/api/v1/setups/:id/stop", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid setup id" });
    const setups = requireSetups(res);
    if (!setups) return;
    try {
      const setup = await setups.stop(id);
      res.status(202).json({ setup });
    } catch (err) {
      if (err instanceof SetupNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof SetupBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof SetupOfflineError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  // Engine log: replays the ring, then streams live lines (per-setup SSE).
  app.get("/api/v1/setups/:id/log", (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid setup id" });
    const setups = requireSetups(res);
    if (!setups) return;
    setups.attachLog(res, id);
  });

  // Staged transfers: build stages from the placement plan and chain them.
  app.post("/api/v1/setups/:id/transfers", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid setup id" });
    const setups = requireSetups(res);
    if (!setups) return;
    const body = req.body as { targetNodeIds?: unknown };
    if (!Array.isArray(body?.targetNodeIds) || body.targetNodeIds.some((t) => typeof t !== "string")) {
      return res.status(400).json({ error: "targetNodeIds is required" });
    }
    try {
      const transfer = await setups.createTransfer(id, body.targetNodeIds as string[]);
      res.status(202).json({ transfer });
    } catch (err) {
      if (err instanceof SetupNotFoundError) return res.status(404).json({ error: err.message });
      throw err;
    }
  });

  app.post("/api/v1/setups/transfers/:id/cancel", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid transfer id" });
    const setups = requireSetups(res);
    if (!setups) return;
    const ok = await setups.cancelTransfer(id);
    if (!ok) return res.status(409).json({ error: "transfer is not cancelable" });
    res.status(202).json({ ok: true });
  });

  // ---- M6: benchmarks ----

  const serializeBenchRun = (row: BenchRunRow) => ({
    id: row.id,
    type: row.type,
    nodeId: row.nodeId,
    status: row.status,
    config: row.config,
    result: row.result,
    error: row.error,
    model: row.model,
    port: row.port,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  });

  const requireBench = (res: Response): BenchService | null => {
    const bench = deps.getBench();
    if (bench === null) res.status(503).json({ error: "database unavailable" });
    return bench;
  };

  app.post("/api/v1/bench/:type", async (req, res) => {
    const bench = requireBench(res);
    if (!bench) return;
    const type = benchTypeSchema.safeParse(req.params.type);
    if (!type.success) return res.status(404).json({ error: "unknown benchmark type" });
    const store = requireStore(res);
    if (!store) return;
    const nodeId = typeof req.body?.nodeId === "string" ? req.body.nodeId : "";
    if (!UUID_RE.test(nodeId)) return res.status(400).json({ error: "nodeId is required" });
    if ((await store.get(nodeId)) === null) return res.status(404).json({ error: "node not found" });
    const config = (req.body?.config ?? req.body ?? {}) as Record<string, unknown>;
    try {
      const run = await bench.start(type.data, nodeId, config);
      res.status(202).json({ run: serializeBenchRun(run) });
    } catch (err) {
      if (err instanceof BenchBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof BenchOfflineError) return res.status(409).json({ error: err.message });
      if (err instanceof Error && err.name === "ZodError") return res.status(400).json({ error: "invalid benchmark config" });
      throw err;
    }
  });

  app.get("/api/v1/bench/:type/runs", async (req, res) => {
    const bench = requireBench(res);
    if (!bench) return;
    const type = benchTypeSchema.safeParse(req.params.type);
    if (!type.success) return res.status(404).json({ error: "unknown benchmark type" });
    const nodeId = typeof req.query.nodeId === "string" && UUID_RE.test(req.query.nodeId) ? req.query.nodeId : undefined;
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const runs = await bench.list(type.data, { nodeId, limit: Number.isFinite(limit) ? limit : undefined });
    res.json({ runs: runs.map(serializeBenchRun) });
  });

  app.get("/api/v1/bench/active", async (req, res) => {
    const bench = requireBench(res);
    if (!bench) return;
    const nodeId = typeof req.query.nodeId === "string" && UUID_RE.test(req.query.nodeId) ? req.query.nodeId : undefined;
    res.json({ runs: (await bench.active(nodeId)).map(serializeBenchRun) });
  });

  app.get("/api/v1/bench/runs/:id", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid run id" });
    const bench = requireBench(res);
    if (!bench) return;
    const run = await bench.get(id);
    if (run === null) return res.status(404).json({ error: "bench run not found" });
    res.json({ run: serializeBenchRun(run) });
  });

  app.post("/api/v1/bench/runs/:id/cancel", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid run id" });
    const bench = requireBench(res);
    if (!bench) return;
    try {
      const run = await bench.cancel(id);
      if (run === null) return res.status(409).json({ error: "bench run not cancelable" });
      res.json({ run: serializeBenchRun(run) });
    } catch (err) {
      if (err instanceof BenchNotFoundError) return res.status(404).json({ error: err.message });
      throw err;
    }
  });

  // Unknown API paths answer JSON, not the SPA.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const staticDir = deps.staticDir;
  if (staticDir !== null && existsSync(staticDir)) {
    app.use(express.static(staticDir));
    // SPA fallback for client-side routes; never swallows /api or /agent-ws.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (req.path.startsWith("/api/") || req.path === "/agent-ws") return next();
      res.sendFile(join(staticDir, "index.html"), (err) => {
        if (err) next();
      });
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const e = err as { status?: number; type?: string } | null;
    const status = e?.type === "entity.parse.failed" ? 400 : (e?.status ?? 500);
    res.status(status).json({ error: status >= 500 ? "internal server error" : "bad request" });
  });

  return app;
}

function toNodeDto(row: NodeRecord, online: boolean): NodeInfo {
  return nodeInfoSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    host: row.host,
    enabled: row.enabled,
    agentVersion: row.agentVersion,
    online,
    lastSeenAt: toIso(row.lastSeenAt),
    sortOrder: row.sortOrder,
    llmPorts: normalizeLlmPorts(row.llmPorts),
    nasRoot: row.nasRoot,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });
}

/** Tolerant jsonb→ports normalization: entries are numbers or {port, host}. */
function normalizeLlmPorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ports: number[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isInteger(entry) && entry > 0) ports.push(entry);
    else if (typeof entry === "object" && entry !== null && "port" in entry && typeof entry.port === "number") ports.push(entry.port);
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

const toIso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function sendZodError(res: Response, error: { issues: Array<{ path: PropertyKey[]; message: string }> }): void {
  res.status(400).json({
    error: "invalid request",
    issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

function parseUuidParam(req: Request): string | null {
  const id = req.params.id;
  return typeof id === "string" && UUID_RE.test(id) ? id : null;
}

/**
 * Validates the PUT /llm-ports body ({ ports: number[] }) without zod (not a
 * server dependency): positive 16-bit ints, deduped, capped at MAX_LLM_PORTS.
 */
function parsePortsBody(body: unknown): number[] | null {
  if (typeof body !== "object" || body === null || !("ports" in body)) return null;
  const ports = body.ports;
  if (!Array.isArray(ports) || ports.length > MAX_LLM_PORTS) return null;
  const out: number[] = [];
  for (const port of ports) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (!out.includes(port)) out.push(port);
  }
  return out.sort((a, b) => a - b);
}
