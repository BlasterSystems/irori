import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { benchTypeSchema, cadencePutSchema, nodeCreateSchema, nodeInfoSchema, nodePatchSchema, setupCreateSchema, setupPatchSchema, compareVersions, AGENT_UPDATE_MIN_VERSION, hfTokenPutSchema, type NodeInfo, type SseEvent } from "@irori/core";
import type { NodeRecord, NodeStore } from "@irori/db";
import type { CadenceService } from "./cadence.js";
import { isHistoryRange, type HistoryResponse, type HistoryRange } from "./history.js";
import { type AnalyticsService } from "./analytics.js";
import { type CleanupService } from "./cleanup-service.js";
import { analyticsLensSchema, analyticsRangeSchema, usageRangeSchema, type UsageRange } from "@irori/core";
import type { UsageStore } from "./usage-store.js";
import type { UsageClients } from "./usage-clients.js";
import type { UsageChats } from "./usage-chats.js";
import { type LlmHistoryResponse } from "./llm-history.js";
import type { LlmStore } from "./llm-store.js";
import { nodeLlmAssignments } from "./llm-store.js";
import { JobBusyError, JobDispatchError, type JobsService } from "./jobs-service.js";
import {
  DownloadBusyError,
  DownloadInvalidTransitionError,
  DownloadNotFoundError,
  DownloadValidationError,
  type DownloadQueueService,
} from "./download-queue-service.js";
import { BenchBusyError, BenchNotFoundError, BenchOfflineError, type BenchRunRow, type BenchService } from "./bench-service.js";
import { HfQuantsError, type HfQuantsService } from "./hf-quants.js";
import type { HfTokenService } from "./hf-token.js";
import { planPlacement } from "@irori/core";
import type { Rings } from "./rings.js";
import type { SseHub } from "./sse.js";
import { EVENT_FEED_CAP } from "./events-feed.js";
import type { AgentHub } from "./hub.js";
import { SetupBusyError, SetupInvalidError, SetupNotFoundError, SetupOfflineError, SetupStartError, type SetupsService } from "./setups-service.js";

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
  /** Null while degraded: usage routes answer 503 (M8). */
  getUsage: () => UsageStore | null;
  /** Null while degraded: client-identity routes answer 503 (IR-55). */
  getUsageClients: () => UsageClients | null;
  /** Null while degraded: chats routes answer 503 (IR-53). */
  getUsageChats: () => UsageChats | null;
  /** Null while degraded: download-queue routes answer 503 (IRI-014). */
  getDownloads: () => DownloadQueueService | null;
  /**
   * IRI-019: global HF token service. Optional — when absent or null
   * (degraded), the settings routes answer 503 and hf-quants lists
   * tokenless, exactly as before.
   */
  getHfToken?: () => HfTokenService | null;
  /**
   * IR-87: cadence setting service. Optional — when absent or null (degraded),
   * the cadence settings route answers 503 exactly like the HF-token routes.
   * getCadenceMs is the in-memory active value (settings row or env default)
   * exposed on the version payload; setCadenceMs keeps it in sync on PUT.
   */
  getCadence?: () => CadenceService | null;
  getCadenceMs?: () => number;
  setCadenceMs?: (cadenceMs: number) => void;
  /** IRI-016: read-only HF quantization listing; store-independent (works degraded). */
  hfQuants: HfQuantsService;
  dbHealthy: () => Promise<boolean>;
  rings: Rings;
  /** SSE hub; when wrapped in the IRI-013 recording feed it also serves /events/recent history. */
  sse: SseHub & { recent?(limit?: number): SseEvent[] };
  getHub: () => Pick<AgentHub, "online" | "sendToNode" | "refreshConfig"> | null;
  version: string;
  /** Git tag the image was built from (IRORI_GIT_TAG); null for local builds. */
  tag: string | null;
  /** apps/web/dist when it exists, else null. */
  staticDir: string | null;
  /**
   * IRI-011 (ADR-0007): agent artifacts served to nodes — resolved once at
   * boot from IRORI_AGENT_ARTIFACTS_DIR (container, flat) or the monorepo
   * apps/agent layout. Null/missing files → 503 on the artifact routes.
   */
  agentArtifacts?: { installer: string; unit: string; bundle: string } | null;
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

  // ---- IRI-011 (ADR-0007): hub-served agent artifacts ----
  // Root-level GETs; registered before the static/SPA fallback below so they
  // are not swallowed by it. No secrets are embedded — the token is supplied
  // by the operator at run time. Works while degraded (no store needed).
  const serveArtifact =
    (kind: "installer" | "unit" | "bundle", type: string, name: string) =>
    (_req: Request, res: Response): void => {
      const path = deps.agentArtifacts?.[kind];
      if (!path || !existsSync(path)) {
        res.status(503).json({ error: "agent artifacts not available" });
        return;
      }
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path);
    };
  app.get("/install-agent.sh", serveArtifact("installer", "text/x-shellscript", "install-agent.sh"));
  app.get("/irori-agent.service", serveArtifact("unit", "text/plain", "irori-agent.service"));
  app.get("/agent/irori-agent.mjs", serveArtifact("bundle", "text/javascript", "irori-agent.mjs"));

  app.get("/api/v1/version", (_req, res) => {
    res.json({
      version: deps.version,
      tag: deps.tag,
      ...(deps.getCadenceMs !== undefined ? { cadenceMs: deps.getCadenceMs() } : {}),
    });
  });

  // IRI-016: GGUF quantization/companion listing for the download modal's
  // expand-quants flow. Read-only proxy of the public HF API — no store, so
  // it also answers while degraded. Upstream/validation failures map to
  // HfQuantsError.status; anything else is a server fault.
  app.get("/api/v1/hf-quants", async (req, res) => {
    const repo = typeof req.query.repo === "string" ? req.query.repo.trim() : "";
    try {
      const hfToken = deps.getHfToken?.() ?? null;
      const token = hfToken === null ? null : await hfToken.get().catch(() => null);
      res.json(await deps.hfQuants.listQuants(repo, token));
    } catch (err) {
      if (err instanceof HfQuantsError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

  // IRI-019: global HF token (ADR-0009 addendum). The GET is presence-only —
  // the token itself never appears in any response body. Optional dep:
  // absent/null (degraded) answers 503 like the other db-backed routes.
  app.get("/api/v1/settings/hf-token", async (_req, res) => {
    const hfToken = deps.getHfToken?.() ?? null;
    if (hfToken === null) return res.status(503).json({ error: "database unavailable" });
    const configured = (await hfToken.get()) !== null;
    res.json({ configured } satisfies { configured: boolean });
  });

  app.put("/api/v1/settings/hf-token", async (req, res) => {
    const hfToken = deps.getHfToken?.() ?? null;
    if (hfToken === null) return res.status(503).json({ error: "database unavailable" });
    const body = hfTokenPutSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    await hfToken.set(body.data.hfToken);
    // Best-effort live push to online agents; offline agents receive the
    // value in the config-update that follows their next hello.
    const hub = deps.getHub();
    if (hub !== null) for (const nodeId of hub.online()) void hub.refreshConfig(nodeId).catch(() => {});
    res.json({ configured: body.data.hfToken !== null });
  });

  // IR-87: hub snapshot cadence — persisted (settings row), bounds-checked,
  // and live-pushed to online agents via config-update. The in-memory active
  // value updates immediately; agents reconnecting read it on next hello.
  app.get("/api/v1/settings/cadence-ms", async (_req, res) => {
    const cadence = deps.getCadence?.() ?? null;
    if (cadence === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ cadenceMs: await cadence.get() } satisfies { cadenceMs: number | null });
  });

  app.put("/api/v1/settings/cadence-ms", async (req, res) => {
    const cadence = deps.getCadence?.() ?? null;
    if (cadence === null) return res.status(503).json({ error: "database unavailable" });
    const body = cadencePutSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    await cadence.set(body.data.cadenceMs);
    deps.setCadenceMs?.(body.data.cadenceMs);
    const hub = deps.getHub();
    if (hub !== null) for (const nodeId of hub.online()) void hub.refreshConfig(nodeId).catch(() => {});
    res.json({ cadenceMs: body.data.cadenceMs } satisfies { cadenceMs: number });
  });

  app.get("/api/v1/events", (_req, res) => {
    deps.sse.subscribe(res);
  });

  // IRI-013: feed history for freshly loaded pages — the SSE stream itself
  // has none. Empty until the hub is wrapped in the recording feed.
  app.get("/api/v1/events/recent", (req, res) => {
    const raw = Number.parseInt(typeof req.query.limit === "string" ? req.query.limit : "", 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), EVENT_FEED_CAP) : 200;
    res.json({ events: deps.sse.recent?.(limit) ?? [] });
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

  // ---- IRI-012 (ADR-0007): one-click agent update to the hub's own version.
  // Refuses while the node is busy: restarting the agent kills its jobs,
  // benches and running setups (the agent supervises them as children).
  app.post("/api/v1/nodes/:id/agent-update", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    const node = await store.get(id);
    if (node === null) return res.status(404).json({ error: "node not found" });
    // An agent older than the kind itself cannot self-update; the first hop
    // to AGENT_UPDATE_MIN_VERSION belongs to the install one-liner.
    if (node.agentVersion !== null && compareVersions(node.agentVersion, AGENT_UPDATE_MIN_VERSION) < 0) {
      return res.status(409).json({
        error: `agent ${node.agentVersion} predates self-update (needs ${AGENT_UPDATE_MIN_VERSION}) — run the install one-liner once, then update from here`,
      });
    }
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const bench = deps.getBench();
    if (bench !== null && (await bench.active(id)).length > 0) {
      return res.status(409).json({ error: "node has a running benchmark — wait for it or cancel it first" });
    }
    const setups = deps.getSetups();
    if (setups !== null) {
      const busy = (await setups.list()).some(
        (s) => s.headNodeId === id && (s.status === "starting" || s.status === "running" || s.status === "stopping"),
      );
      if (busy) return res.status(409).json({ error: "node has a running setup — stop it first (an agent restart kills it)" });
    }
    try {
      const job = await jobs.create(id, "agent-update", { expectedVersion: deps.version });
      res.status(202).json({ job: serializeJob(job) });
    } catch (err) {
      if (err instanceof JobBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof JobDispatchError) return res.status(409).json({ error: err.message });
      throw err;
    }
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

  // ---- M8: usage capture (SPEC §13, ADR-0008) ----
  const requireUsage = (res: Response): UsageStore | null => {
    const usage = deps.getUsage();
    if (usage === null) res.status(503).json({ error: "database unavailable" });
    return usage;
  };
  const usageFilters = (req: Request): { range: UsageRange; nodeId?: string; model?: string; project?: string; agentType?: "main" | "subagent" } | null => {
    const range = usageRangeSchema.safeParse(req.query.range);
    if (!range.success) return null;
    const nodeId = typeof req.query.nodeId === "string" && UUID_RE.test(req.query.nodeId) ? req.query.nodeId : undefined;
    const model = typeof req.query.model === "string" && req.query.model.length > 0 && req.query.model.length <= 300 ? req.query.model : undefined;
    const project = typeof req.query.project === "string" && req.query.project.length > 0 && req.query.project.length <= 200 ? req.query.project : undefined;
    const agentType = req.query.agentType === "main" || req.query.agentType === "subagent" ? req.query.agentType : undefined;
    return { range: range.data, nodeId, model, project, agentType };
  };

  app.get("/api/v1/usage/overview", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const filters = usageFilters(req);
    if (filters === null) return res.status(400).json({ error: "unknown range" });
    res.json(await usage.overview(filters));
  });

  app.get("/api/v1/usage/requests", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const filters = usageFilters(req);
    if (filters === null) return res.status(400).json({ error: "unknown range" });
    const pageRaw = Number.parseInt(typeof req.query.page === "string" ? req.query.page : "", 10);
    const limitRaw = Number.parseInt(typeof req.query.limit === "string" ? req.query.limit : "", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const errorOnly = req.query.errors === "1" || req.query.errors === "true";
    const sig = typeof req.query.sig === "string" && req.query.sig.length > 0 ? req.query.sig.slice(0, 240) : undefined;
    const statusRaw = Number.parseInt(typeof req.query.status === "string" ? req.query.status : "", 10);
    const status = Number.isFinite(statusRaw) && statusRaw >= 100 && statusRaw <= 599 ? statusRaw : undefined;
    res.json(await usage.requests({ ...filters, page, limit, errorOnly, sig, status }));
  });

  app.get("/api/v1/usage/requests/:id", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid request id" });
    const row = await usage.requestById(id);
    if (row === null) return res.status(404).json({ error: "request not found" });
    res.json(row);
  });

  app.get("/api/v1/usage/errors", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const filters = usageFilters(req);
    if (filters === null) return res.status(400).json({ error: "unknown range" });
    res.json(await usage.errorGroups(filters));
  });

  app.get("/api/v1/usage/models", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const filters = usageFilters(req);
    if (filters === null) return res.status(400).json({ error: "unknown range" });
    res.json(await usage.models(filters));
  });

  // ---- IR-55: client identity ----
  const requireUsageClients = (res: Response): UsageClients | null => {
    const clients = deps.getUsageClients();
    if (clients === null) res.status(503).json({ error: "database unavailable" });
    return clients;
  };

  app.get("/api/v1/usage/agents", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const filters = usageFilters(req);
    if (filters === null) return res.status(400).json({ error: "unknown range" });
    res.json(await usage.agents(filters));
  });

  app.get("/api/v1/usage/tools", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const filters = usageFilters(req);
    if (filters === null) return res.status(400).json({ error: "unknown range" });
    res.json(await usage.tools(filters));
  });

  app.get("/api/v1/usage/clients", async (_req, res) => {
    const clients = requireUsageClients(res);
    if (clients === null) return;
    res.json({ clients: await clients.list() });
  });

  app.post("/api/v1/usage/clients", async (req, res) => {
    const clients = requireUsageClients(res);
    if (clients === null) return;
    const body = req.body as { name?: unknown; project?: unknown; agentType?: unknown };
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return res.status(400).json({ error: "name is required" });
    }
    if (body.project !== undefined && body.project !== null && (typeof body.project !== "string" || body.project.length > 200)) {
      return res.status(400).json({ error: "project must be a string of at most 200 chars" });
    }
    if (body.agentType !== undefined && body.agentType !== null && body.agentType !== "main" && body.agentType !== "subagent") {
      return res.status(400).json({ error: "agentType must be main or subagent" });
    }
    try {
      const created = await clients.create({
        name: body.name,
        project: typeof body.project === "string" ? body.project : null,
        agentType: body.agentType === "main" || body.agentType === "subagent" ? body.agentType : null,
      });
      res.status(201).json(created);
    } catch {
      // Validation already answered 400 above; everything else is a server fault.
      res.status(500).json({ error: "identity creation failed" });
    }
  });

  app.delete("/api/v1/usage/clients/:id", async (req, res) => {
    const clients = requireUsageClients(res);
    if (clients === null) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid identity id" });
    const removed = await clients.remove(id);
    if (!removed) return res.status(404).json({ error: "identity not found" });
    res.json({ ok: true });
  });

  // ---- IR-53: chats (session reconstruction from stored bodies) ----
  const requireUsageChats = (res: Response): UsageChats | null => {
    const chats = deps.getUsageChats();
    if (chats === null) res.status(503).json({ error: "database unavailable" });
    return chats;
  };

  app.get("/api/v1/usage/chats", async (req, res) => {
    const chats = requireUsageChats(res);
    if (chats === null) return;
    const filters = usageFilters(req);
    if (filters === null) return res.status(400).json({ error: "unknown range" });
    res.json(await chats.list(filters));
  });

  app.get("/api/v1/usage/chats/:id", async (req, res) => {
    const chats = requireUsageChats(res);
    if (chats === null) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid chat id" });
    const detail = await chats.detail(id);
    if (detail === null) return res.status(404).json({ error: "chat not found" });
    res.json(detail);
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
    const body = req.body as { kind?: unknown; params?: unknown };
    if (typeof body?.kind !== "string") return res.status(400).json({ error: "kind is required" });
    // agent-update MUST go through the dedicated endpoint: it injects
    // expectedVersion (without which the job can never settle and blocks
    // the node forever) and runs the version/setup guards.
    if (body.kind === "agent-update") {
      return res.status(400).json({
        error: "agent-update must use POST /api/v1/nodes/:id/agent-update",
      });
    }
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
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

  // ---- IRI-014: server-side download queue ----
  // Adding a download ALWAYS queues; the server picks the store node
  // (NAS-preferred) and drains pending entries as one download-queue batch
  // whenever it is idle. The per-node jobs route above stays for hygiene,
  // sync, push and other model-ops verbs.
  app.get("/api/v1/downloads", async (_req, res) => {
    const downloads = deps.getDownloads();
    if (downloads === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ entries: await downloads.list() });
  });

  app.post("/api/v1/downloads", async (req, res) => {
    const downloads = deps.getDownloads();
    if (downloads === null) return res.status(503).json({ error: "database unavailable" });
    try {
      // IRI-015: `{downloads: […]}` is the bulk form (atomic insert, one
      // drain attempt); the single `{source, …}` shape stays for back-compat.
      const isBatch = typeof req.body === "object" && req.body !== null && "downloads" in req.body && Array.isArray(req.body.downloads);
      const body = isBatch ? await downloads.enqueueBatch(req.body) : [await downloads.enqueue(req.body)];
      res.status(202).json(body.length === 1 ? { entry: body[0] } : { entries: body });
    } catch (err) {
      if (err instanceof DownloadValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.delete("/api/v1/downloads/:id", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid download id" });
    const downloads = deps.getDownloads();
    if (downloads === null) return res.status(503).json({ error: "database unavailable" });
    try {
      await downloads.remove(id);
      res.status(204).end();
    } catch (err) {
      if (err instanceof DownloadNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof DownloadBusyError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  app.post("/api/v1/downloads/:id/retry", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid download id" });
    const downloads = deps.getDownloads();
    if (downloads === null) return res.status(503).json({ error: "database unavailable" });
    try {
      // IRI-017: {force: true} opts the retry into manifest replacement.
      const body = typeof req.body === "object" && req.body !== null ? req.body : {};
      const force = (body as { force?: unknown }).force === true;
      const entry = await downloads.retry(id, { force });
      res.json({ entry });
    } catch (err) {
      if (err instanceof DownloadNotFoundError) return res.status(404).json({ error: err.message });
      if (err instanceof DownloadInvalidTransitionError) return res.status(409).json({ error: err.message });
      throw err;
    }
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
      if (err instanceof SetupInvalidError) return res.status(400).json({ error: err.message });
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
      if (err instanceof SetupInvalidError) return res.status(400).json({ error: err.message });
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
