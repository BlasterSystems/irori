import { registerNetworkRoutes } from "./network-routes.js";
import type { NetworkService } from "./network-service.js";
import type { NetworkSettingsService } from "./network-settings.js";
import type { NetLiveService } from "./network-live.js";
import type { NetworkTestsService } from "./network-tests.js";
import type { LinkHistory } from "./network-history.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { otelRequestMiddleware } from "./otel.js";
import { broadcastForLanIp, normalizeMac, sendWol } from "./wol.js";
import { benchTypeSchema, bundleState, cadencePutSchema, nodeCreateSchema, nodeInfoSchema, nodePatchSchema, setupCreateSchema, setupPatchSchema, compareVersions, AGENT_UPDATE_MIN_VERSION, hfTokenPutSchema, auditQuerySchema, logQuerySchema, type HardwareSnapshot, type NodeInfo, type SetupInfo, type SseEvent } from "@irori/core";
import type { NodeRecord, NodeStore } from "@irori/db";
import type { CadenceService } from "./cadence.js";
import { isHistoryRange, type HistoryResponse, type HistoryRange } from "./history.js";
import { type AnalyticsService } from "./analytics.js";
import { type CleanupService } from "./cleanup-service.js";
import { inventoryStale, type InventoryService } from "./inventory-service.js";
import { analyticsLensSchema, analyticsRangeSchema, usageCostGroupBySchema, usageRangeSchema, type UsageRange } from "@irori/core";
import { energyCostPutSchema, tokenCostPutSchema, modelPricePutSchema, modelctlPinPutSchema, type EnergyCost, type TokenCost, type ModelctlPinResponse, type ModelPricesResponse } from "@irori/core";
import type { CostService } from "./cost.js";
import type { HealthService } from "./health.js";
import { renderPrometheus } from "./metrics.js";
import { guardCounters } from "./process-guards.js";
import type { UpdateBaseline } from "./updates-baseline.js";
import { recipeInstallRequestSchema } from "@irori/core";
import type { RecipeService } from "./recipes.js";
import type { CommunityService } from "./community.js";
import type { ModelctlPinService } from "./modelctl-pin.js";
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
import { planPlacement, storeCompanionsStateSchema, type StoreCompanionsState } from "@irori/core";
import type { Rings } from "./rings.js";
import type { SseHub } from "./sse.js";
import { EVENT_FEED_CAP } from "./events-feed.js";
import type { AgentHub } from "./hub.js";
import { SetupBusyError, SetupInvalidError, SetupNotFoundError, SetupOfflineError, SetupStartError, type SetupsService } from "./setups-service.js";
import type { AuditService } from "./audit.js";
import type { EventJournalService } from "./event-journal.js";
import type { LogStore } from "./logs-store.js";
import { audit, auditReadOnly } from "./audit-routes.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_NODES_ONLINE: ReadonlySet<string> = new Set();
/** Upper bound on probe assignments accepted per node. */
const MAX_LLM_PORTS = 32;
/** Models-page page size (M1 Models v2 spec: 25/page). */
const MODELS_PAGE_SIZE = 25;

/**
 * IRI-155: `model_meta.meta.companions` as the API exposes it. Re-validated
 * on the way out: the column is agent-supplied JSON. undefined = never
 * reported (or not a valid value).
 */
export function storedCompanions(meta: unknown): StoreCompanionsState | undefined {
  if (typeof meta !== "object" || meta === null || !("companions" in meta)) return undefined;
  const parsed = storeCompanionsStateSchema.safeParse((meta as { companions: unknown }).companions);
  return parsed.success ? parsed.data : undefined;
}
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
  progress: { bytes: number | null; percent: number | null; rateBytesPerSec: number | null; etaSeconds: number | null } | null;
  cancelRequestedAt: Date | null;
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
    progress: job.progress,
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    exitCode: job.exitCode,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** Setup fields worth auditing — the definition, not the transient health. */
function summarizeSetup(setup: SetupInfo): Record<string, unknown> {
  return {
    name: setup.name,
    kind: setup.kind,
    model: setup.model,
    port: setup.port,
    headNodeId: setup.headNodeId,
    nodes: setup.nodes,
    scriptStart: setup.scriptStart,
    scriptStop: setup.scriptStop,
    env: setup.env,
    captureProxy: setup.captureProxy,
    bodyRetention: setup.bodyRetention,
    status: setup.status,
    startupTimeoutMs: setup.startupTimeoutMs,
  };
}

/** Node fields worth auditing — never the token material (redaction backstops it). */
function summarizeNode(row: NodeRecord): Record<string, unknown> {
  return {
    name: row.name,
    kind: row.kind,
    role: row.role,
    host: row.host,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    llmPorts: row.llmPorts,
    nasRoot: row.nasRoot,
    cacheUser: row.cacheUser,
    wolMac: row.wolMac,
    gpuClockCapMHz: row.gpuClockCapMHz,
    gpuClockCapPersistent: row.gpuClockCapPersistent,
    cpuClockCapMHz: row.cpuClockCapMHz,
    cpuClockCapPersistent: row.cpuClockCapPersistent,
  };
}

/**
 * Accepted clock-cap range, mirroring `nodeInfoSchema` (300–4000 MHz). The
 * route must enforce it: the value is stored verbatim and re-parsed by the node
 * DTO, so an out-of-range cap would 500 every `GET /api/v1/nodes` until someone
 * edits the row by hand.
 */
const CLOCK_CAP_MIN_MHZ = 300;
const CLOCK_CAP_MAX_MHZ = 4000;

/** One clock-cap body field: absent = leave that side alone, null = clear. */
type CapField = { ok: true; value: number | null | undefined } | { ok: false };

function parseCapField(raw: unknown): CapField {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw >= CLOCK_CAP_MIN_MHZ &&
    raw <= CLOCK_CAP_MAX_MHZ
  ) {
    return { ok: true, value: raw };
  }
  return { ok: false };
}

const CAP_FIELD_HINT = `a positive integer between ${CLOCK_CAP_MIN_MHZ} and ${CLOCK_CAP_MAX_MHZ}, or null`;

/** Builds a history response; null while degraded (no DB wired yet). */
export type HistoryBuilder = (nodeId: string, range: HistoryRange) => Promise<HistoryResponse>;

/** Builds an llm history response; null while degraded (no DB wired yet). */
export type LlmHistoryBuilder = (nodeId: string, range: HistoryRange) => Promise<LlmHistoryResponse>;

/** Node-row fields the agent's config-update consumes (hub.ts sendConfigUpdate). */
const AGENT_CONFIG_KEYS = new Set(["llmPorts", "role", "nasRoot", "cacheUser"]);

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
  /** Null while degraded: node-model inventory reads answer 503 (IRI-028). */
  getInventory?: () => InventoryService | null;
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
  /** IRI-162 (ADR-0021): fleet network topology; absent or null = 503. */
  getNetwork?: () => NetworkService | null;
  /** ADR-0021: network kill switches + prober interval; absent or null = 503. */
  getNetworkSettings?: () => NetworkSettingsService | null;
  /** IRI-168: per-link minute history; absent or null = 503. */
  getLinkHistory?: () => LinkHistory | null;
  /** IRI-166: on-demand link tests; absent or null = 503. */
  getNetworkTests?: () => NetworkTestsService | null;
  /** IRI-164: the leased live-rate stream; absent or null = 503. */
  getNetLive?: () => NetLiveService | null;
  /** Called after a successful PUT /api/v1/settings/network. */
  onNetworkSettingsChanged?: () => void;
  /** IRI-025: energy/token cost settings. Optional — when absent or null
   *  (degraded), the cost settings routes answer 503 like the cadence routes. */
  getCost?: () => CostService | null;
  /** IR-105: hub-pinned modelctl version. Optional — when absent or null
   *  (degraded), the setting routes answer 503 and no auto-provisioning is
   *  dispatched (agents keep their env pin). */
  getModelctlPin?: () => ModelctlPinService | null;
  /** IR-272: a node's model cache user was set or changed, and the agent
   *  has been sent the new config — converge that user's setup. */
  onCacheUserChanged?: (nodeId: string) => void;
  /**
   * IRI-077: durable audit log. Optional — absent/null (degraded) routes
   * behave exactly as unmanaged; mutating routes never fail because of it.
   */
  getAudit?: () => AuditService | null;
  /** IRI-077: restart-surviving fleet event journal (GET /events/journal). */
  getEventJournal?: () => EventJournalService | null;
  /** IRI-078: durable structured logs (GET /logs, /logs/summary). */
  getLogs?: () => LogStore | null;
  getCadenceMs?: () => number;
  setCadenceMs?: (cadenceMs: number) => void;
  /** IRI-016: read-only HF quantization listing; store-independent (works degraded). */
  hfQuants: HfQuantsService;
  dbHealthy: () => Promise<boolean>;
  rings: Rings;
  /** SSE hub; when wrapped in the IRI-013 recording feed it also serves /events/recent history. */
  sse: SseHub & { recent?(limit?: number): SseEvent[] };
  getHub: () => Pick<AgentHub, "online" | "sendToNode" | "refreshConfig" | "clocks" | "setClocks" | "shutdownNode" | "isScopeCapable"> | null;
  getHealth?: () => HealthService | null;
  getNodesSnapshot?: () => Promise<Array<{ id: string; name: string; online: boolean; snapshot: HardwareSnapshot | null }>>;
  /** IRI-081: cached/release-notes baseline (created in index.ts with the db). */
  getBaseline?: () => Promise<UpdateBaseline | null>;
  /** IRI-082: curated recipe catalog service. */
  getRecipes?: () => RecipeService | null;
  /** IRI-083: community intelligence service. */
  getCommunity?: () => CommunityService | null;
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
  // IRI-039/IR-116: env-gated request spans — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
  app.use(otelRequestMiddleware);
  app.use(express.json());

  // Degraded mode (ADR-0002): while the store is absent, store-backed routes
  // answer 503 and nothing else in the API is affected.
  const requireStore = (res: Response): NodeStore | null => {
    const store = deps.getStore();
    if (store === null) res.status(503).json({ error: "database unavailable" });
    return store;
  };

  // IRI-077: audit is best-effort and optional — while the service is absent
  // (degraded boot) marked routes behave exactly as unmanaged ones.
  const getAudit = (): AuditService | null => deps.getAudit?.() ?? null;

  app.get("/healthz", async (_req, res) => {
    res.json({ ok: true, db: await deps.dbHealthy(), version: deps.version });
  });

  // IR-260: sha256 of the artifact the hub serves, cached by mtime so the
  // node payloads do not re-read a 2 MB bundle per request. A missing or
  // unreadable artifact → null; the node's bundle state renders "unknown".
  const bundleHash = { path: "", mtimeMs: -1, sha: null as string | null };
  function expectedBundleSha256(): string | null {
    const path = deps.agentArtifacts?.bundle;
    if (path === undefined) return null;
    try {
      const st = statSync(path);
      if (path !== bundleHash.path || st.mtimeMs !== bundleHash.mtimeMs) {
        bundleHash.path = path;
        bundleHash.mtimeMs = st.mtimeMs;
        bundleHash.sha = createHash("sha256").update(readFileSync(path)).digest("hex");
      }
      return bundleHash.sha;
    } catch {
      return null;
    }
  }

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
      // root + basename: send rejects any dot-segment in an absolute path,
      // which 404'd these routes when the hub sat under a hidden dir (~/.x/).
      res.sendFile(basename(path), { root: dirname(path) });
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

  app.put(
    "/api/v1/settings/hf-token",
    audit(
      {
        action: "settings.hf-token.put",
        targetType: "settings",
        targetId: () => "hf-token",
        // Presence only, never the value: the summary says a token was set or
        // cleared, and the redaction layer would strip the value anyway.
        summary: (req) => {
          const body: unknown = req.body;
          const value = body && typeof body === "object" && "hfToken" in body ? body.hfToken : null;
          return `hf-token ${value === null || value === undefined ? "cleared" : "set"}`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
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

  app.put(
    "/api/v1/settings/cadence-ms",
    audit({ action: "settings.cadence-ms.put", targetType: "settings", targetId: () => "cadence-ms" }, getAudit),
    async (req, res) => {
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

  // IRI-025: energy + token cost settings (settings rows; the Overview power
  // and token cost previews read them). Null = not configured.
  app.get("/api/v1/settings/energy-cost", async (_req, res) => {
    const cost = deps.getCost?.() ?? null;
    if (cost === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ energyCost: await cost.getEnergy() } satisfies { energyCost: EnergyCost | null });
  });

  app.put(
    "/api/v1/settings/energy-cost",
    audit({ action: "settings.energy-cost.put", targetType: "settings", targetId: () => "energy-cost" }, getAudit),
    async (req, res) => {
    const cost = deps.getCost?.() ?? null;
    if (cost === null) return res.status(503).json({ error: "database unavailable" });
    const body = energyCostPutSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    await cost.setEnergy(body.data);
    res.json({ energyCost: body.data } satisfies { energyCost: EnergyCost });
  });

  // IR-105: hub-pinned modelctl version. Null = not configured — agents keep
  // their env pin and no auto-provisioning is dispatched. A PUT pushes the
  // new pin to every connected agent via config-update (cadence pattern).
  app.get("/api/v1/settings/modelctl-pin", async (_req, res) => {
    const pin = deps.getModelctlPin?.() ?? null;
    if (pin === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ pin: await pin.get() } satisfies ModelctlPinResponse);
  });

  app.put(
    "/api/v1/settings/modelctl-pin",
    audit({ action: "settings.modelctl-pin.put", targetType: "settings", targetId: () => "modelctl-pin" }, getAudit),
    async (req, res) => {
    const pin = deps.getModelctlPin?.() ?? null;
    if (pin === null) return res.status(503).json({ error: "database unavailable" });
    const body = modelctlPinPutSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    await pin.set(body.data.pin);
    const hub = deps.getHub();
    if (hub !== null) for (const nodeId of hub.online()) void hub.refreshConfig(nodeId).catch(() => {});
    res.json({ pin: body.data.pin } satisfies { pin: string });
  });

  app.get("/api/v1/settings/token-cost", async (_req, res) => {
    const cost = deps.getCost?.() ?? null;
    if (cost === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ tokenCost: await cost.getToken() } satisfies { tokenCost: TokenCost | null });
  });

  app.put(
    "/api/v1/settings/token-cost",
    audit({ action: "settings.token-cost.put", targetType: "settings", targetId: () => "token-cost" }, getAudit),
    async (req, res) => {
    const cost = deps.getCost?.() ?? null;
    if (cost === null) return res.status(503).json({ error: "database unavailable" });
    const body = tokenCostPutSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    await cost.setToken(body.data);
    // IRI-072: prices changed — drop the stamps, the backfill re-prices.
    await cost.resetCostStamps();
    res.json({ tokenCost: body.data } satisfies { tokenCost: TokenCost });
  });

  // ---- IRI-072: per-model price overrides ----
  app.get("/api/v1/settings/model-prices", async (_req, res) => {
    const cost = deps.getCost?.() ?? null;
    if (cost === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ prices: await cost.listModelPrices() } satisfies ModelPricesResponse);
  });

  app.put(
    "/api/v1/settings/model-prices",
    audit({ action: "settings.model-price.put", targetType: "settings", targetId: () => "model-prices" }, getAudit),
    async (req, res) => {
      const cost = deps.getCost?.() ?? null;
      if (cost === null) return res.status(503).json({ error: "database unavailable" });
      const body = modelPricePutSchema.safeParse(req.body);
      if (!body.success) return sendZodError(res, body.error);
      await cost.setModelPrice(body.data);
      await cost.resetCostStamps();
      res.json({ prices: await cost.listModelPrices() } satisfies ModelPricesResponse);
    },
  );

  app.delete(
    "/api/v1/settings/model-prices/:pattern",
    audit({ action: "settings.model-price.delete", targetType: "settings", targetId: (req) => (typeof req.params.pattern === "string" ? req.params.pattern : null) }, getAudit),
    async (req, res) => {
      const cost = deps.getCost?.() ?? null;
      if (cost === null) return res.status(503).json({ error: "database unavailable" });
      const pattern = req.params.pattern;
      if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 200) return res.status(400).json({ error: "invalid pattern" });
      await cost.deleteModelPrice(pattern);
      await cost.resetCostStamps();
      res.json({ prices: await cost.listModelPrices() } satisfies ModelPricesResponse);
    },
  );

  // ---- IRI-077: durable audit log + event journal reads ----
  app.get("/api/v1/audit", async (req, res) => {
    const auditService = deps.getAudit?.() ?? null;
    if (auditService === null) return res.status(503).json({ error: "database unavailable" });
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendZodError(res, parsed.error);
    res.json(await auditService.list(parsed.data));
  });

  // Restart-surviving operational events (the /events/recent ring is memory-only).
  app.get("/api/v1/events/journal", async (req, res) => {
    const journal = deps.getEventJournal?.() ?? null;
    if (journal === null) return res.status(503).json({ error: "database unavailable" });
    const range = req.query.range === "1h" || req.query.range === "7d" || req.query.range === "30d" ? req.query.range : "24h";
    const type = typeof req.query.type === "string" && req.query.type.length > 0 && req.query.type.length <= 64 ? req.query.type : undefined;
    const nodeId = typeof req.query.nodeId === "string" && req.query.nodeId.length > 0 && req.query.nodeId.length <= 64 ? req.query.nodeId : undefined;
    const limitRaw = Number.parseInt(typeof req.query.limit === "string" ? req.query.limit : "", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
    const cursorRaw = Number.parseInt(typeof req.query.cursor === "string" ? req.query.cursor : "", 10);
    const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : undefined;
    res.json(await journal.list({ range, type, nodeId, limit, cursor }));
  });

  // IRI-078: durable structured logs — the record behind the ring/feed.
  // `after` switches to ascending tail mode (the Logs view's live tail).
  app.get("/api/v1/logs", async (req, res) => {
    const store = deps.getLogs?.() ?? null;
    if (store === null) return res.status(503).json({ error: "database unavailable" });
    const parsed = logQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendZodError(res, parsed.error);
    res.json(await store.list(parsed.data));
  });

  // Counts per level for the filter-bar chips (same filters, no paging).
  app.get("/api/v1/logs/summary", async (req, res) => {
    const store = deps.getLogs?.() ?? null;
    if (store === null) return res.status(503).json({ error: "database unavailable" });
    const parsed = logQuerySchema.safeParse({ ...req.query, limit: 1 });
    if (!parsed.success) return sendZodError(res, parsed.error);
    const { limit: _limit, cursor: _cursor, after: _after, ...filters } = parsed.data;
    res.json(await store.summary(filters));
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
    res.json((await store.list()).map((row) => toNodeDto(row, online.has(row.id), expectedBundleSha256())));
  });

  app.post(
    "/api/v1/nodes",
    audit(
      {
        action: "node.create",
        targetType: "node",
        // The id only exists after the insert; the handler publishes it.
        targetId: () => null,
        summary: (req) => {
          const body: unknown = req.body;
          const name = body && typeof body === "object" && "name" in body && typeof body.name === "string" ? body.name : "?";
          return `node created (${name})`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const body = nodeCreateSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    const created = await store.create(body.data);
    res.locals.auditTargetId = created.id;
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
      llmPorts: body.data.llmPorts ?? [],
      nasRoot: body.data.nasRoot ?? null,
      cacheUser: body.data.cacheUser ?? null,
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json({ node, token: created.token });
  });

  app.patch(
    "/api/v1/nodes/:id",
    audit(
      {
        action: "node.patch",
        targetType: "node",
        snapshot: async (req) => {
          const id = parseUuidParam(req);
          const row = id === null ? null : await (deps.getStore()?.get(id) ?? Promise.resolve(null));
          return row === null ? null : summarizeNode(row);
        },
      },
      getAudit,
    ),
    async (req, res) => {
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
    const before = await store.get(id);
    if (before === null) return res.status(404).json({ error: "node not found" });
    // IR-272: a new (non-empty) cache user needs its own modelctl and HF
    // cache. Read the old value before patching (a store may hand back the
    // row it then mutates).
    const previousCacheUser = (before.cacheUser ?? "").trim();
    const nextCacheUser = typeof patch.cacheUser === "string" ? patch.cacheUser.trim() : "";
    const cacheUserChanged = "cacheUser" in patch && nextCacheUser !== "" && nextCacheUser !== previousCacheUser;
    await store.patch(id, patch);
    // IRI-034: agent-consumed fields changed → push a fresh config-update
    // now; without this the agent keeps its old probe set (ghosting removed
    // ports) until the next WS reconnect.
    if (Object.keys(patch).some((k) => AGENT_CONFIG_KEYS.has(k))) {
      const hub = deps.getHub();
      if (hub !== null) {
        // The inventory must run under the new cache user: dispatch only
        // after the config-update has gone out (it can overtake otherwise).
        void hub
          .refreshConfig(id)
          .then((sent) => {
            if (sent && cacheUserChanged) deps.onCacheUserChanged?.(id);
          })
          .catch(() => {});
      }
    }
    const row = await store.get(id);
    if (row === null) return res.status(404).json({ error: "node not found" });
    res.json({ node: toNodeDto(row, onlineSet().has(id), expectedBundleSha256()) });
  });

  app.delete(
    "/api/v1/nodes/:id",
    audit(
      {
        action: "node.delete",
        targetType: "node",
        summary: (req) => `node deleted (${req.params.id ?? "?"})`,
        snapshot: async (req) => {
          const id = parseUuidParam(req);
          const row = id === null ? null : await (deps.getStore()?.get(id) ?? Promise.resolve(null));
          return row === null ? null : summarizeNode(row);
        },
      },
      getAudit,
    ),
    async (req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    await store.remove(id);
    deps.rings.remove(id);
    res.status(204).end();
  });

  app.post(
    "/api/v1/nodes/:id/token/rotate",
    audit(
      {
        action: "node.token.rotate",
        targetType: "node",
        // The new token value is secret: only the fact of rotation is recorded.
        summary: (req) => `agent token rotated for node ${req.params.id ?? "?"}`,
      },
      getAudit,
    ),
    async (req, res) => {
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
  app.post(
    "/api/v1/nodes/:id/agent-update",
    audit(
      {
        action: "node.agent-update",
        targetType: "node",
        summary: (req) => `agent update dispatched to node ${req.params.id ?? "?"}`,
      },
      getAudit,
    ),
    async (req, res) => {
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
      if (busy) {
        // ADR-0017: agents that isolate setups in systemd scope units survive
        // their own restarts — updating them no longer kills running engines.
        // The hello-reported capability is the gate; the agent re-checks with
        // ground truth at dispatch (unscooped setups refuse the job).
        if (deps.getHub()?.isScopeCapable(id) !== true) {
          return res.status(409).json({ error: "node has a running setup — stop it first (an agent restart kills it)" });
        }
      }
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

  registerNetworkRoutes(app, {
    getNetwork: () => deps.getNetwork?.() ?? null,
    getSettings: () => deps.getNetworkSettings?.() ?? null,
    onSettingsChanged: () => deps.onNetworkSettingsChanged?.(),
    getAudit,
    getLive: () => deps.getNetLive?.() ?? null,
    getTests: () => deps.getNetworkTests?.() ?? null,
    getHistory: () => deps.getLinkHistory?.() ?? null,
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

  // IRI-073 / IRI-071: concrete analytics routes. These MUST be registered
  // before the /api/v1/analytics/:lens catch-all below — Express matches in
  // registration order, and the catch-all would otherwise shadow both with
  // 400 "unknown lens" (defect recorded in tasks/IRI-131-overflow-sweep.md).
  app.get("/api/v1/analytics/efficiency", async (req, res) => {
    const analytics = deps.getAnalytics();
    if (analytics === null) return res.status(503).json({ error: "database unavailable" });
    const range = analyticsRangeSchema.safeParse(req.query.range ?? "24h");
    if (!range.success) return res.status(400).json({ error: "unknown range" });
    const groupBy = req.query.groupBy === "model" ? "model" : "node";
    res.json(await analytics.efficiency({ range: range.data, groupBy }));
  });

  app.get("/api/v1/analytics/token-reconciliation", async (req, res) => {
    const analytics = deps.getAnalytics();
    if (analytics === null) return res.status(503).json({ error: "database unavailable" });
    const range = analyticsRangeSchema.safeParse(req.query.range ?? "4h");
    if (!range.success) return res.status(400).json({ error: "unknown range" });
    const nodeIdRaw = typeof req.query.nodeId === "string" ? req.query.nodeId : undefined;
    const nodeId = nodeIdRaw !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeIdRaw) ? nodeIdRaw : undefined;
    res.json(await analytics.reconciliation({ range: range.data, nodeId }));
  });

  // ---- M7: analytics (SPEC §9) — five lenses over the rollup buckets ----
  app.get("/api/v1/analytics/:lens", async (req, res) => {
    const lens = analyticsLensSchema.safeParse(req.params.lens);
    if (!lens.success) return res.status(400).json({ error: "unknown lens" });
    const range = analyticsRangeSchema.safeParse(req.query.range);
    if (!range.success) return res.status(400).json({ error: "unknown range" });
    const rawGroup = req.query.groupBy;
    const groupBy = rawGroup === "cluster" || rawGroup === "node" || rawGroup === "setup" ? rawGroup : "node";
    const setupId = typeof req.query.setupId === "string" ? req.query.setupId : undefined;
    const offsetMsRaw = Number.parseInt(typeof req.query.offsetMs === "string" ? req.query.offsetMs : "", 10);
    const offsetMs = Number.isFinite(offsetMsRaw) && offsetMsRaw > 0 ? offsetMsRaw : undefined;
    const nodeId = typeof req.query.nodeId === "string" ? req.query.nodeId : undefined;
    const service = deps.getAnalytics();
    if (service === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await service.build({ lens: lens.data, range: range.data, groupBy, setupId, nodeId, offsetMs }));
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

  // IRI-072: per-group cost rows (model|client|setup|day|node).
  app.get("/api/v1/usage/cost", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const filters = usageFilters(req);
    if (filters === null) return res.status(400).json({ error: "unknown range" });
    const groupBy = usageCostGroupBySchema.safeParse(req.query.groupBy);
    if (!groupBy.success) return res.status(400).json({ error: "unknown groupBy" });
    res.json(await usage.cost({ range: filters.range, nodeId: filters.nodeId, groupBy: groupBy.data }));
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

  app.post(
    "/api/v1/usage/clients",
    audit(
      {
        action: "usage-client.create",
        targetType: "usage-client",
        targetId: () => null,
        // The issued key is secret and one-time; only the identity is recorded.
        summary: (req) => {
          const body: unknown = req.body;
          const name = body && typeof body === "object" && "name" in body && typeof body.name === "string" ? body.name : "?";
          return `client identity created (${name})`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
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
      res.locals.auditTargetId = created.id;
      res.status(201).json(created);
    } catch {
      // Validation already answered 400 above; everything else is a server fault.
      res.status(500).json({ error: "identity creation failed" });
    }
  });

  app.delete(
    "/api/v1/usage/clients/:id",
    audit({ action: "usage-client.delete", targetType: "usage-client" }, getAudit),
    async (req, res) => {
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

  app.put(
    "/api/v1/nodes/:id/hygiene",
    audit(
      {
        action: "node.hygiene.put",
        targetType: "hygiene",
        summary: (req) => {
          const body: unknown = req.body;
          const weekly = body && typeof body === "object" && "weeklySafePass" in body ? String(body.weeklySafePass) : "?";
          return `hygiene prevention set for node ${req.params.id ?? "?"} (weeklySafePass=${weekly})`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
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

  // ---- IRI-080: per-node version provenance + drift ----
  app.get("/api/v1/nodes/:id/versions", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const inventory = deps.getInventory?.() ?? null;
    const entry = inventory === null ? null : await inventory.get(id);
    const report = (entry?.report ?? null) as { versions?: unknown; local?: Array<{ user: string; modelctlVersion: string | null }> } | null;
    const versions = report?.versions ?? null;
    // Drift: the hub pin vs each cache user's modelctl. Unknown versions are
    // surfaced as unknown, never as a violation.
    const pin = (await deps.getModelctlPin?.()?.get()) ?? null;
    const drift = pin === null ? [] : (report?.local ?? []).map((c) => ({
      user: c.user,
      modelctlVersion: c.modelctlVersion,
      belowPin: c.modelctlVersion !== null && c.modelctlVersion !== pin,
    }));
    res.json({ agentVersion: (await store.get(id))?.agentVersion ?? null, pin, versions, drift, updatedAt: entry?.updatedAt ?? null });
  });

  // ---- IRI-081: OS/firmware/driver update posture (informational only) ----
  app.get("/api/v1/updates", async (_req, res) => {
    const store = requireStore(res);
    if (!store) return;
    const inventory = deps.getInventory?.() ?? null;
    if (inventory === null) return res.status(503).json({ error: "database unavailable" });
    const baseline = deps.getBaseline === undefined ? null : await deps.getBaseline().catch(() => null);
    const nodeRows = await store.list();
    const online = deps.getHub()?.online() ?? new Set<string>();
    const matrix = await Promise.all(
      nodeRows.map(async (n) => {
        const entry = await inventory.get(n.id).catch(() => null);
        const report = (entry?.report ?? null) as { updates?: { dgxOsVersion: string | null; nvidiaDriverVersion: string | null; pendingReboot: boolean; upgradableCount: number | null; nvidiaDgxPending?: number | null; aptPresent: boolean } } | null;
        const u = report?.updates ?? null;
        let posture: "unknown" | "up to date" | "behind" | "pending reboot" | "update tooling absent" = "unknown";
        if (u !== null && !u.aptPresent) posture = "update tooling absent";
        else if (u?.pendingReboot === true) posture = "pending reboot";
        else if (u !== null && (u.nvidiaDgxPending ?? 0) > 0) {
          // IR-258: pending NVIDIA/DGX packages are the DGX OTA channel — the
          // exact signal the DGX dashboard advertises as a system update.
          // Unlike generic apt counts (IR-243) this subset is verdict-bearing.
          posture = "behind";
        } else if (u !== null && baseline !== null) {
          // IR-243: generic apt upgradable counts are NOT the posture — 125
          // pending Ubuntu packages rendered every node permanently "behind".
          // The posture compares DGX OS + driver against the hub baseline;
          // the count keeps its own row in the NodeDetail Updates card.
          const behindDriver = baseline.driver !== null && u.nvidiaDriverVersion !== null && u.nvidiaDriverVersion !== baseline.driver;
          const behindOs = baseline.dgxOs !== null && u.dgxOsVersion !== null && u.dgxOsVersion !== baseline.dgxOs;
          posture = behindDriver || behindOs ? "behind" : "up to date";
        }
        // IR-255: the report's collection time — the Updates card renders the
        // age so a stale row cannot pose as fresh.
        return { nodeId: n.id, name: n.name, online: online.has(n.id), updates: u, posture, reportAt: entry?.updatedAt ?? null };
      }),
    );
    res.json({ baseline, nodes: matrix });
  });

  // ---- IRI-082: curated recipe catalog (SparkRun + MiaAI) ----
  app.get("/api/v1/recipes", async (_req, res) => {
    const recipes = deps.getRecipes?.();
    if (recipes === undefined || recipes === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await recipes.list());
  });

  app.post("/api/v1/recipes/:id/hide", audit({ action: "recipes.hide", targetType: "recipe", targetId: (req) => (typeof req.params.id === "string" ? req.params.id : null) }, getAudit), async (req, res) => {
    const recipes = deps.getRecipes?.();
    if (recipes === undefined || recipes === null) return res.status(503).json({ error: "database unavailable" });
    await recipes.setHidden((typeof req.params.id === "string" ? req.params.id : ""), req.body?.hidden !== false);
    res.json({ ok: true });
  });

  app.post("/api/v1/recipes/:id/pin", audit({ action: "recipes.pin", targetType: "recipe", targetId: (req) => (typeof req.params.id === "string" ? req.params.id : null) }, getAudit), async (req, res) => {
    const recipes = deps.getRecipes?.();
    if (recipes === undefined || recipes === null) return res.status(503).json({ error: "database unavailable" });
    const sha = await recipes.pin((typeof req.params.id === "string" ? req.params.id : ""));
    if (sha === null) return res.status(502).json({ error: "pin failed (upstream unreachable or not a GitHub repo)" });
    res.json({ pinnedSha: sha });
  });

  // Install = stage scripts on the target node (sha256-verified) via a job;
  // the settled job yields a DRAFT the operator confirms (nothing starts).
  app.post("/api/v1/recipes/:id/install", audit({ action: "recipes.install", targetType: "recipe", targetId: (req) => (typeof req.params.id === "string" ? req.params.id : null) }, getAudit), async (req, res) => {
    const recipes = deps.getRecipes?.();
    if (recipes === undefined || recipes === null) return res.status(503).json({ error: "database unavailable" });
    const parsed = recipeInstallRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid install request", issues: parsed.error.issues });
    try {
      const jobId = await recipes.install((typeof req.params.id === "string" ? req.params.id : ""), parsed.data);
      res.status(202).json({ jobId });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : "install failed" });
    }
  });

  app.get("/api/v1/recipes/drafts/:jobId", async (req, res) => {
    const recipes = deps.getRecipes?.();
    if (recipes === undefined || recipes === null) return res.status(503).json({ error: "database unavailable" });
    const draft = await recipes.draft(req.params.jobId ?? "");
    if (draft === null) return res.status(404).json({ error: "draft not ready (job not settled) or unknown" });
    res.json(draft);
  });

  // ---- IRI-083: community intelligence (pollers in index.ts; read-only here) ----
  app.get("/api/v1/community", async (_req, res) => {
    const community = deps.getCommunity?.();
    if (community === undefined || community === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await community.view());
  });

  app.post("/api/v1/community/:id", audit({ action: "community.curate", targetType: "community-item", targetId: (req) => (typeof req.params.id === "string" ? req.params.id : null) }, getAudit), async (req, res) => {
    const community = deps.getCommunity?.();
    if (community === undefined || community === null) return res.status(503).json({ error: "database unavailable" });
    const patch: { hidden?: boolean; pinned?: boolean; seen?: boolean } = {};
    if (typeof req.body?.hidden === "boolean") patch.hidden = req.body.hidden;
    if (typeof req.body?.pinned === "boolean") patch.pinned = req.body.pinned;
    if (typeof req.body?.seen === "boolean") patch.seen = req.body.seen;
    await community.curate((typeof req.params.id === "string" ? req.params.id : ""), patch);
    res.json({ ok: true });
  });

  // ---- IRI-028: per-node model inventory (store + per-user local caches) ----
  app.get("/api/v1/nodes/:id/models", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const inventory = deps.getInventory?.() ?? null;
    if (inventory === null) return res.status(503).json({ error: "database unavailable" });
    const entry = await inventory.get(id);
    res.json({ report: entry?.report ?? null, updatedAt: entry?.updatedAt ?? null });
  });

  // Dispatches the read-only inventory job; 409 while the node has any active
  // job (one-active-per-node), 202 otherwise.
  app.post(
    "/api/v1/nodes/:id/models/refresh",
    audit(
      {
        action: "node.models-refresh",
        targetType: "node",
        summary: (req) => `inventory refresh dispatched for node ${req.params.id ?? "?"}`,
      },
      getAudit,
    ),
    async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    // IR-248: a non-null report younger than 60 s is reused instead of
    // dispatching — the double-click / auto-try + manual-click pair that
    // produced two byte-identical jobs 19.7 s apart (DGX-3, 2026-11-14).
    const inventory = deps.getInventory?.() ?? null;
    if (inventory !== null) {
      const entry = await inventory.get(id).catch(() => null);
      if (entry !== null && !inventoryStale(entry, Date.now(), 60_000)) {
        return res.json({ reused: true, report: entry.report, updatedAt: entry.updatedAt });
      }
    }
    try {
      // IRI-080: the agent stats the setups' recipe scripts for the stale
      // chip — collected here so the agent never learns db shape.
      let scriptPaths: string[] = [];
      try {
        const setups = await deps.getSetups()?.list();
        for (const s of setups ?? []) {
          if (typeof s.scriptStart === "string") scriptPaths.push(s.scriptStart);
          if (typeof s.scriptStop === "string") scriptPaths.push(s.scriptStop);
        }
        scriptPaths = [...new Set(scriptPaths)].slice(0, 50);
      } catch {
        scriptPaths = [];
      }
      const job = await jobs.create(id, "models-inventory", { scriptPaths });
      res.status(202).json({ job: serializeJob(job) });
    } catch (err) {
      if (err instanceof JobBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof JobDispatchError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  // Live llm probe view: in-memory ring first, latest persisted pass as
  // fallback (fresh boot, agent still to reconnect). 404 when nothing is known
  // — except for a NAS, which has no LLM surface at all (IR-192): its agent
  // never probes ports, so "nothing known" is the permanent truth and the
  // empty set is the honest answer.
  app.get("/api/v1/nodes/:id/llm", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    const node = await store.get(id);
    if (node === null) return res.status(404).json({ error: "node not found" });
    const entry = deps.rings.latestLlm(id);
    if (entry !== undefined) {
      return res.json({ ports: entry.ports, updatedAt: new Date(entry.serverTimeMs).toISOString() });
    }
    const llmStore = deps.getLlmStore();
    const fallback = llmStore === null ? null : await llmStore.latestLlmSnapshot(id);
    if (fallback !== null) {
      return res.json({ ports: fallback.ports, updatedAt: new Date(fallback.serverTimeMs).toISOString() });
    }
    if (node.kind === "nas") return res.json({ ports: [], updatedAt: null });
    res.status(404).json({ error: "no llm data available" });
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

  /** One per-side clock-cap outcome (IR-199): appliedMHz is the cap the node now runs — the requested value for an applied side, null for a clear or a failure. Sides left alone get no entry. */
  type ClockCapOutcome = { side: "gpu" | "cpu"; ok: boolean; offline: boolean; error: string | null; appliedMHz: number | null };

  /**
   * IRI-124: apply each requested clock side in its OWN agent frame. One frame
   * per side keeps the outcome unambiguous, so a GPU cap that landed is stored
   * even when the CPU half fails (an aggregated frame left the registry
   * claiming "no caps" while the node ran a capped clock and booted with it).
   * An old agent drops a CPU-only frame → that side reports offline, the GPU
   * side still applies and stores.
   */
  async function applyClockCaps(
    id: string,
    store: { setGpuClockCap(id: string, cap: number | null, persistent: boolean): Promise<void>; setCpuClockCap(id: string, cap: number | null, persistent: boolean): Promise<void> },
    caps: { gpu?: number | null; cpu?: number | null },
    persistent: boolean,
  ): Promise<{
    status: number;
    body: Record<string, unknown>;
    results: ClockCapOutcome[];
  }> {
    const hub = deps.getHub();
    const results: ClockCapOutcome[] = [];
    if (hub === null) {
      return { status: 503, body: { error: "agent hub unavailable" }, results };
    }
    const apply = async (side: "gpu" | "cpu", value: number | null): Promise<void> => {
      const reply =
        side === "gpu"
          ? await hub.setClocks(id, { smMaxMHz: value }, persistent)
          : await hub.setClocks(id, { cpuMaxMHz: value }, persistent);
      if (reply === null) {
        results.push({ side, ok: false, offline: true, error: "node agent offline or no reply", appliedMHz: null });
        return;
      }
      if (!reply.ok) {
        results.push({ side, ok: false, offline: false, error: reply.error ?? "clock cap failed", appliedMHz: null });
        return;
      }
      if (side === "gpu") await store.setGpuClockCap(id, value, persistent && value !== null);
      else await store.setCpuClockCap(id, value, persistent && value !== null);
      // IR-199: the agent applied exactly the requested value (or refused the
      // frame), so the applied cap is the value this frame carried — null on a clear.
      results.push({ side, ok: true, offline: false, error: null, appliedMHz: value });
    };
    if (caps.gpu !== undefined) await apply("gpu", caps.gpu);
    if (caps.cpu !== undefined) await apply("cpu", caps.cpu);

    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) return { status: 200, body: {}, results };
    // Every failure being "no reply" is a reachability problem (504); anything
    // else is the agent refusing the cap (502). The CPU hint covers the
    // agent-rollout window, where an old agent drops the frame outright.
    const offlineOnly = failed.every((r) => r.offline);
    const hints = failed.map((r) => {
      const hint = r.side === "cpu" && r.offline ? " (CPU clock control needs the current agent build)" : "";
      return `${r.side}: ${r.error}${hint}`;
    });
    return {
      status: offlineOnly ? 504 : 502,
      body: { error: hints.join("; "), results },
      results,
    };
  }

  // ---- IRI-067: clock endpoints (SPEC §13) — live read + SM cap via the agent ----

  app.get("/api/v1/nodes/:id/clocks", async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid node id" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const hub = deps.getHub();
    if (hub === null) return res.status(503).json({ error: "agent hub unavailable" });
    const result = await hub.clocks(id);
    if (result === null) return res.status(504).json({ error: "node agent offline or no reply" });
    if (!result.ok) return res.status(502).json({ error: result.error ?? "clocks query failed" });
    // IRI-124: cpu is null when the platform has no cpufreq policies and ABSENT
    // when the agent predates CPU clock control. The distinction must survive
    // the wire, otherwise the UI tells an operator to update a current agent.
    const payload: Record<string, unknown> = { gpus: result.gpus };
    if (result.cpu !== undefined) payload.cpu = result.cpu;
    res.json(payload);
  });

  app.post(
    "/api/v1/nodes/:id/clocks",
    audit(
      {
        action: "node.clocks.post",
        targetType: "node",
        summary: (req) => {
          const body: unknown = req.body;
          const smMax = body && typeof body === "object" && "smMaxMHz" in body ? String((body as { smMaxMHz: unknown }).smMaxMHz) : "?";
          const cpuMax = body && typeof body === "object" && "cpuMaxMHz" in body ? String((body as { cpuMaxMHz: unknown }).cpuMaxMHz) : "?";
          return `clock cap set for node ${req.params.id ?? "?"} (smMaxMHz=${smMax}, cpuMaxMHz=${cpuMax})`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
      const id = parseUuidParam(req);
      if (id === null) return res.status(400).json({ error: "invalid node id" });
      const store = requireStore(res);
      if (!store) return;
      if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
      const body = (req.body ?? {}) as { smMaxMHz?: unknown; cpuMaxMHz?: unknown } | null;
      // IRI-124: absent leaves that side alone (the old "absent = -rgc reset"
      // shape made a CPU-only call silently clear the GPU cap); null clears.
      const gpu = parseCapField(body?.smMaxMHz);
      if (!gpu.ok) return res.status(400).json({ error: `smMaxMHz must be ${CAP_FIELD_HINT}` });
      const cpu = parseCapField(body?.cpuMaxMHz);
      if (!cpu.ok) return res.status(400).json({ error: `cpuMaxMHz must be ${CAP_FIELD_HINT}` });
      if (gpu.value === undefined && cpu.value === undefined) {
        return res.status(400).json({ error: "smMaxMHz or cpuMaxMHz required" });
      }
      // Persistence is the clock-cap route's job: it is the one that records
      // the boot-time state on the node, so a one-shot apply here must never
      // install or remove a oneshot behind the registry's back.
      const outcome = await applyClockCaps(id, store, { gpu: gpu.value, cpu: cpu.value }, false);
      const after = outcome.status === 200 ? await deps.getHub()?.clocks(id) : null;
      res.status(outcome.status).json({
        ...(outcome.status === 200 ? {} : outcome.body),
        gpus: after?.ok ? after.gpus : [],
        cpu: after?.ok ? (after.cpu ?? null) : null,
        results: outcome.results,
      });
    },
  );

  // ---- IRI-068: power actions — armed shutdown, WoL wake, clock-cap registry ----

  const shutdownArmed = new Map<string, { token: string; expiresAt: number }>();

  app.post(
    "/api/v1/nodes/:id/shutdown",
    audit({ action: "node.shutdown.post", targetType: "node", summary: (req) => `shutdown armed for node ${req.params.id ?? "?"}` }, getAudit),
    async (req, res) => {
      const id = parseUuidParam(req);
      if (id === null) return res.status(400).json({ error: "invalid node id" });
      const store = requireStore(res);
      if (!store) return;
      const node = await store.get(id);
      if (node === null) return res.status(404).json({ error: "node not found" });
      const body = (req.body ?? {}) as { confirmToken?: unknown; origin?: unknown };
      const armed = shutdownArmed.get(id);
      if (typeof body.confirmToken !== "string" || body.confirmToken.length === 0) {
        // Step 1: arm. A second call without the token re-arms (fresh token).
        const token = randomUUID();
        const expiresAt = Date.now() + 60_000;
        shutdownArmed.set(id, { token, expiresAt });
        return res.json({ armed: true, confirmToken: token, expiresAt: new Date(expiresAt).toISOString() });
      }
      // Step 2: confirm. A stale/unknown token is rejected and audited.
      if (armed === undefined || armed.token !== body.confirmToken) {
        return res.status(409).json({ error: "stale confirm token — arm again" });
      }
      if (Date.now() > armed.expiresAt) {
        shutdownArmed.delete(id);
        return res.status(409).json({ error: "stale confirm token — arm again" });
      }
      shutdownArmed.delete(id);
      const hub = deps.getHub();
      if (hub === null) return res.status(503).json({ error: "agent hub unavailable" });
      const origin = typeof body.origin === "string" && body.origin.length > 0 ? body.origin.slice(0, 200) : "web";
      // Audited by the route middleware above (records on finish, before the
      // agent's poweroff lands — the ack only confirms scheduling).
      const result = await hub.shutdownNode(id, 10, origin);
      if (result === null) return res.status(504).json({ error: "node agent offline or no reply" });
      if (!result.ok) return res.status(502).json({ error: result.error ?? "shutdown dispatch failed" });
      res.json({ scheduled: true, graceS: 10 });
    },
  );

  app.post(
    "/api/v1/nodes/:id/wake",
    audit({ action: "node.wake.post", targetType: "node", summary: (req) => `wake-on-lan sent for node ${req.params.id ?? "?"}` }, getAudit),
    async (req, res) => {
      const id = parseUuidParam(req);
      if (id === null) return res.status(400).json({ error: "invalid node id" });
      const store = requireStore(res);
      if (!store) return;
      const node = await store.get(id);
      if (node === null) return res.status(404).json({ error: "node not found" });
      const body = (req.body ?? {}) as { mac?: unknown };
      const mac = normalizeMac(body.mac) ?? normalizeMac(node.wolMac);
      if (mac === null) return res.status(400).json({ error: "no wolMac on node and no mac in body" });
      const broadcast = broadcastForLanIp(node.host);
      try {
        // Directed /24 first (survives some switched fabrics), then global.
        await sendWol(mac, broadcast);
        if (broadcast !== "255.255.255.255") await sendWol(mac, "255.255.255.255");
        res.json({ sent: true, mac, broadcast });
      } catch (err: unknown) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.put(
    "/api/v1/nodes/:id/clock-cap",
    audit({ action: "node.clock-cap.put", targetType: "node", summary: (req) => {
      const body: unknown = req.body;
      const cap = body && typeof body === "object" && "capMHz" in body ? String((body as { capMHz: unknown }).capMHz) : "?";
      const cpuCap = body && typeof body === "object" && "cpuCapMHz" in body ? String((body as { cpuCapMHz: unknown }).cpuCapMHz) : "?";
      return `clock cap set for node ${req.params.id ?? "?"} (capMHz=${cap}, cpuCapMHz=${cpuCap})`;
    } }, getAudit),
    async (req, res) => {
      const id = parseUuidParam(req);
      if (id === null) return res.status(400).json({ error: "invalid node id" });
      const store = requireStore(res);
      if (!store) return;
      const node = await store.get(id);
      if (node === null) return res.status(404).json({ error: "node not found" });
      const body = (req.body ?? {}) as { capMHz?: unknown; cpuCapMHz?: unknown; persistent?: unknown } | null;
      // IRI-124: the two halves move independently — an absent field leaves that
      // side alone, null clears it. `persistent` with a null cap therefore means
      // "drop the boot-time re-apply", which is how Clear actually sticks.
      const gpu = parseCapField(body?.capMHz);
      if (!gpu.ok) return res.status(400).json({ error: `capMHz must be ${CAP_FIELD_HINT}` });
      const cpu = parseCapField(body?.cpuCapMHz);
      if (!cpu.ok) return res.status(400).json({ error: `cpuCapMHz must be ${CAP_FIELD_HINT}` });
      if (gpu.value === undefined && cpu.value === undefined) {
        return res.status(400).json({ error: "capMHz or cpuCapMHz required" });
      }
      const persistent = body?.persistent === true;
      // Each side is applied and recorded on its own, so a partial failure
      // leaves the registry telling the truth about the half that landed.
      const outcome = await applyClockCaps(id, store, { gpu: gpu.value, cpu: cpu.value }, persistent);
      if (outcome.status !== 200) {
        return res.status(outcome.status).json({
          ...outcome.body,
          // Read the registry back so a partial success is visible.
          capMHz: (await store.get(id))?.gpuClockCapMHz ?? null,
          cpuCapMHz: (await store.get(id))?.cpuClockCapMHz ?? null,
          persistent,
        });
      }
      const after = await deps.getHub()?.clocks(id);
      res.json({
        capMHz: gpu.value === undefined ? node.gpuClockCapMHz : gpu.value,
        cpuCapMHz: cpu.value === undefined ? node.cpuClockCapMHz : cpu.value,
        persistent,
        gpus: after?.ok ? after.gpus : [],
        cpu: after?.ok ? (after.cpu ?? null) : null,
        results: outcome.results,
      });
    },
  );

  /**
   * IR-189: fleet-wide clock caps — one action fans out to every enabled spark
   * node. Each node is applied independently (same per-side contract as the
   * per-node route), so a partial fleet is reported per node rather than
   * collapsed into one status: 200 all applied, 207 partial, 502 none.
   */
  app.post(
    "/api/v1/clock-cap",
    audit(
      {
        action: "fleet.clock-cap.post",
        targetType: "fleet",
        summary: (req) => {
          const body: unknown = req.body;
          const cap = body && typeof body === "object" && "capMHz" in body ? String((body as { capMHz: unknown }).capMHz) : "?";
          const cpuCap = body && typeof body === "object" && "cpuCapMHz" in body ? String((body as { cpuCapMHz: unknown }).cpuCapMHz) : "?";
          return `fleet clock cap (capMHz=${cap}, cpuCapMHz=${cpuCap})`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
      const store = requireStore(res);
      if (!store) return;
      const body = (req.body ?? {}) as { capMHz?: unknown; cpuCapMHz?: unknown; persistent?: unknown } | null;
      const gpu = parseCapField(body?.capMHz);
      if (!gpu.ok) return res.status(400).json({ error: `capMHz must be ${CAP_FIELD_HINT}` });
      const cpu = parseCapField(body?.cpuCapMHz);
      if (!cpu.ok) return res.status(400).json({ error: `cpuCapMHz must be ${CAP_FIELD_HINT}` });
      if (gpu.value === undefined && cpu.value === undefined) {
        return res.status(400).json({ error: "capMHz or cpuCapMHz required" });
      }
      if (deps.getHub() === null) return res.status(503).json({ error: "agent hub unavailable" });
      const persistent = body?.persistent === true;
      // NAS hosts have no GPU and no cpufreq policy to cap.
      const targets = (await store.list()).filter((n) => n.kind === "spark" && n.enabled);
      const results: Array<{ nodeId: string; name: string; status: number; results: ClockCapOutcome[] }> = [];
      for (const node of targets) {
        const outcome = await applyClockCaps(node.id, store, { gpu: gpu.value, cpu: cpu.value }, persistent);
        results.push({ nodeId: node.id, name: node.name, status: outcome.status, results: outcome.results });
      }
      const failed = results.filter((r) => r.status !== 200).length;
      const status = failed === 0 ? 200 : failed === results.length ? 502 : 207;
      res.status(status).json({ results, applied: results.length - failed, failed, persistent });
    },
  );

  // IRI-079: normalized span tree for the request drawer's Trace tab.
  app.get("/api/v1/usage/requests/:id/trace", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid request id" });
    const trace = await usage.requestTrace(id);
    if (trace === null) return res.status(404).json({ error: "request not found" });
    res.json(trace);
  });

  // IRI-076: retry waste — superseded attempts grouped per client key.
  app.get("/api/v1/usage/retries", async (req, res) => {
    const usage = requireUsage(res);
    if (usage === null) return;
    const range = usageRangeSchema.safeParse(req.query.range ?? "24h");
    if (!range.success) return res.status(400).json({ error: "unknown range" });
    const nodeId = typeof req.query.nodeId === "string" ? req.query.nodeId : undefined;
    res.json(await usage.retries({ range: range.data, nodeId }));
  });

  // ---- IRI-069: health rules, findings, thresholds, prometheus ----

  app.get("/api/v1/health/rules", async (_req, res) => {
    const health = deps.getHealth?.() ?? null;
    if (health === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ rules: await health.listRules() });
  });

  app.put(
    "/api/v1/health/rules/:id",
    audit({ action: "health.rule.put", targetType: "health-rule", targetId: (req) => (typeof req.params.id === "string" ? req.params.id : null), summary: (req) => `health rule updated (${req.params.id ?? "?"})` }, getAudit),
    async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid rule id" });
    const health = deps.getHealth?.() ?? null;
    if (health === null) return res.status(503).json({ error: "database unavailable" });
    const body = (req.body ?? null) as Record<string, unknown> | null;
    if (body === null || typeof body !== "object") return res.status(400).json({ error: "body required" });
    const rule = await health.setRule(id, body);
    if (rule === null) return res.status(404).json({ error: "rule not found" });
    res.json({ rule });
  });

  app.get("/api/v1/health/findings", async (_req, res) => {
    const health = deps.getHealth?.() ?? null;
    if (health === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ findings: await health.findings() });
  });

  app.get("/api/v1/health/thresholds", async (_req, res) => {
    const health = deps.getHealth?.() ?? null;
    if (health === null) return res.status(503).json({ error: "database unavailable" });
    res.json(await health.thresholds());
  });

  app.get("/api/v1/settings/metrics", async (_req, res) => {
    const health = deps.getHealth?.() ?? null;
    if (health === null) return res.status(503).json({ error: "database unavailable" });
    res.json({ enabled: await health.metricsEnabled() });
  });

  app.put(
    "/api/v1/settings/metrics",
    audit({ action: "settings.metrics.put", targetType: "settings", targetId: () => "metrics", summary: (req) => {
      const body: unknown = req.body;
      return `prometheus metrics export ${body && typeof body === "object" && (body as { enabled?: unknown }).enabled === true ? "enabled" : "disabled"}`;
    } }, getAudit),
    async (req, res) => {
    const health = deps.getHealth?.() ?? null;
    if (health === null) return res.status(503).json({ error: "database unavailable" });
    const body = req.body as { enabled?: unknown } | null;
    if (body === null || typeof body.enabled !== "boolean") return res.status(400).json({ error: "body must be { enabled: boolean }" });
    await health.setMetricsEnabled(body.enabled);
    res.json({ enabled: body.enabled });
  });

  // Prometheus export — 404 while the flag is off (default).
  app.get("/api/v1/metrics", async (_req, res) => {
    const health = deps.getHealth?.() ?? null;
    if (health === null || !(await health.metricsEnabled().catch(() => false))) {
      return res.status(404).json({ error: "metrics export disabled" });
    }
    const nodes = (await deps.getNodesSnapshot?.().catch(() => [])) ?? [];
    res.type("text/plain; version=0.0.4").send(renderPrometheus(nodes, guardCounters()));
  });

  // Dedicated probe-assignment endpoint (M3); PATCH /nodes/:id covers the
  // same field via nodePatchSchema. Body: { ports: number[] }.
  app.put(
    "/api/v1/nodes/:id/llm-ports",
    audit(
      {
        action: "node.llm-ports.put",
        targetType: "node",
        summary: (req) => `llm probe ports set for node ${req.params.id ?? "?"}`,
      },
      getAudit,
    ),
    async (req, res) => {
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
    // IRI-034: deliver the new probe set immediately, not on the next reconnect.
    const hub = deps.getHub();
    if (hub !== null) void hub.refreshConfig(id).catch(() => {});
    const row = await store.get(id);
    res.json({ llmPorts: nodeLlmAssignments(row) });
  });

  // ---- M4: jobs, models, placement ----

  // Enqueue + dispatch a job to the node's agent (one active per node).
  app.post(
    "/api/v1/nodes/:id/jobs",
    audit(
      {
        action: "node.job-dispatch",
        targetType: "job",
        targetId: () => null,
        summary: (req) => {
          const body: unknown = req.body;
          const kind = body && typeof body === "object" && "kind" in body && typeof body.kind === "string" ? body.kind : "?";
          return `job dispatched (${kind}) to node ${req.params.id ?? "?"}`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
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
    // IRI-166 (ADR-0021): link-test jobs only through /api/v1/network/tests,
    // which applies the kill switch, the busy-endpoint guard, the one-test
    // limit and persistence; a direct dispatch would bypass all four.
    if (body.kind === "net-tool-ensure" || body.kind === "net-test-server" || body.kind === "net-test-client") {
      return res.status(400).json({ error: `${body.kind} must be started through POST /api/v1/network/tests` });
    }
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(id)) === null) return res.status(404).json({ error: "node not found" });
    const params = (body.params ?? {}) as Record<string, unknown>;
    try {
      const job = await jobs.create(id, body.kind, params);
      res.locals.auditTargetId = job.id;
      res.status(202).json({ job: serializeJob(job) });
    } catch (err) {
      if (err instanceof JobBusyError) return res.status(409).json({ error: err.message });
      if (err instanceof JobDispatchError) return res.status(409).json({ error: err.message });
      if (err instanceof Error && err.name === "ZodError") return res.status(400).json({ error: "unknown job kind" });
      throw err;
    }
  });

  // IRI-028: recent jobs across every node — the Telemetry feed's job context
  // seed (SSE `job`/`job-progress` frames keep it live afterwards; IR-102).
  app.get("/api/v1/jobs", async (req, res) => {
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const raw = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : 20;
    const limit = Number.isFinite(raw) ? raw : 20;
    const rows = await jobs.listAll(limit);
    res.json({ jobs: rows.map((row) => ({ ...serializeJob(row), lastLine: row.lastLine })) });
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

  app.post(
    "/api/v1/jobs/:id/cancel",
    audit({ action: "job.cancel", targetType: "job" }, getAudit),
    async (req, res) => {
    const id = parseUuidParam(req);
    if (id === null) return res.status(400).json({ error: "invalid job id" });
    const jobs = deps.getJobs();
    if (jobs === null) return res.status(503).json({ error: "database unavailable" });
    const result = await jobs.cancel(id);
    if (result.ok) return res.status(204).end();
    // IR-131: honest failures — the UI must never believe a transfer stopped
    // when its process is still running (offline node / already canceling).
    const messages: Record<Exclude<(typeof result)["reason"], "ok">, string> = {
      missing: "job not found",
      terminal: "job not cancelable",
      canceling: "cancel already in flight",
      "agent-update": "agent-update cancel is not supported",
      offline: "node offline — the transfer process may still be running",
    };
    return res.status(409).json({ error: messages[result.reason] });
  });

  // IR-262: clear the transfers dock's history — every settled job row
  // (succeeded/failed/canceled). Queued/running rows and the active slot are
  // untouched; job_output cascades and download_queue/cleanup_runs references
  // go NULL (schema FKs). Audited like job.cancel.
  app.delete(
    "/api/v1/jobs",
    audit({ action: "jobs.clear-history", targetType: "jobs", targetId: () => null }, getAudit),
    async (_req, res) => {
      const jobs = deps.getJobs();
      if (jobs === null) return res.status(503).json({ error: "database unavailable" });
      return res.json({ deleted: await jobs.clearHistory() });
    },
  );

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

  app.post(
    "/api/v1/downloads",
    audit({ action: "download.enqueue", targetType: "download", targetId: () => null }, getAudit),
    async (req, res) => {
    const downloads = deps.getDownloads();
    if (downloads === null) return res.status(503).json({ error: "database unavailable" });
    try {
      // IRI-015: `{downloads: […]}` is the bulk form (atomic insert, one
      // drain attempt); the single `{source, …}` shape stays for back-compat.
      const isBatch = typeof req.body === "object" && req.body !== null && "downloads" in req.body && Array.isArray(req.body.downloads);
      const body = isBatch ? await downloads.enqueueBatch(req.body) : [await downloads.enqueue(req.body)];
      res.locals.auditTargetId = body.map((e) => e.id).join(",");
      res.status(202).json(body.length === 1 ? { entry: body[0] } : { entries: body });
    } catch (err) {
      if (err instanceof DownloadValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

  app.delete(
    "/api/v1/downloads/:id",
    audit({ action: "download.delete", targetType: "download" }, getAudit),
    async (req, res) => {
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

  app.post(
    "/api/v1/downloads/:id/retry",
    audit({ action: "download.retry", targetType: "download" }, getAudit),
    async (req, res) => {
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
    const models = filtered.slice((page - 1) * MODELS_PAGE_SIZE, page * MODELS_PAGE_SIZE).map((m) => {
      const companions = storedCompanions(m.meta);
      return {
        ...m,
        firstSeenAt: m.firstSeenAt instanceof Date ? m.firstSeenAt.toISOString() : String(m.firstSeenAt ?? ""),
        updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : String(m.updatedAt ?? ""),
        // IRI-155: absent = unknown (no agent has reported it yet).
        ...(companions === undefined ? {} : { companions }),
      };
    });
    res.json({ page, pageSize: MODELS_PAGE_SIZE, total, models });
  });

  // Ask model-ops agents to re-report their store catalog.
  app.post(
    "/api/v1/models/refresh",
    audit({ action: "model.catalog-refresh", targetType: "model", targetId: () => null }, getAudit),
    async (_req, res) => {
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
    // plus every node a succeeded transfer left it on. The online flag feeds
    // the CX7-first planner (IR-100): a reachable holder beats the store hop.
    const presentNodeIds = await jobs.presentNodesFor(model);
    const availableOn = [
      { nodeId: "nas", bytes: entry.bytes },
      ...presentNodeIds.map((nodeId) => ({ nodeId, bytes: entry.bytes, online: online.has(nodeId) })),
    ];
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
        node: { id: row.id, name: row.name, kind: row.kind, role: row.role, host: row.host, cacheUser: row.cacheUser ?? null, online: online.has(row.id) },
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
  app.post(
    "/api/v1/setups/validate-scripts",
    // Read-only probe: `test -x` on the head agent, no state changes (IRI-077
    // declares the exemption so the coverage gate stays loud for the rest).
    auditReadOnly("setup script validation (test -x, no side effects)"),
    async (req, res) => {
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

  app.post(
    "/api/v1/setups",
    audit(
      {
        action: "setup.create",
        targetType: "setup",
        targetId: () => null,
        summary: (req) => {
          const body: unknown = req.body;
          const name = body && typeof body === "object" && "name" in body && typeof body.name === "string" ? body.name : "?";
          return `setup created (${name})`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
    const setups = requireSetups(res);
    if (!setups) return;
    const body = setupCreateSchema.safeParse(req.body);
    if (!body.success) return sendZodError(res, body.error);
    const store = requireStore(res);
    if (!store) return;
    if ((await store.get(body.data.headNodeId)) === null) return res.status(400).json({ error: "unknown head node" });
    try {
      const createdSetup = await setups.create(body.data);
      res.locals.auditTargetId = createdSetup.id;
      res.locals.auditAfter = summarizeSetup(createdSetup);
      res.status(201).json({ setup: createdSetup });
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

  app.patch(
    "/api/v1/setups/:id",
    audit(
      {
        action: "setup.patch",
        targetType: "setup",
        snapshot: async (req) => {
          const id = parseUuidParam(req);
          if (id === null) return null;
          const setup = await (deps.getSetups()?.get(id) ?? Promise.resolve(null));
          return setup === null ? null : summarizeSetup(setup);
        },
      },
      getAudit,
    ),
    async (req, res) => {
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

  app.delete(
    "/api/v1/setups/:id",
    audit(
      {
        action: "setup.delete",
        targetType: "setup",
        summary: (req) => `setup deleted (${req.params.id ?? "?"})`,
        snapshot: async (req) => {
          const id = parseUuidParam(req);
          if (id === null) return null;
          const setup = await (deps.getSetups()?.get(id) ?? Promise.resolve(null));
          return setup === null ? null : summarizeSetup(setup);
        },
      },
      getAudit,
    ),
    async (req, res) => {
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

  app.post(
    "/api/v1/setups/:id/start",
    audit({ action: "setup.start", targetType: "setup", summary: (req) => `setup started (${req.params.id ?? "?"})` }, getAudit),
    async (req, res) => {
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

  app.post(
    "/api/v1/setups/:id/stop",
    audit({ action: "setup.stop", targetType: "setup", summary: (req) => `setup stopped (${req.params.id ?? "?"})` }, getAudit),
    async (req, res) => {
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
  app.post(
    "/api/v1/setups/:id/transfers",
    audit(
      {
        action: "setup.transfer",
        targetType: "transfer",
        // Default target is the route's :id — the setup; the created transfer
        // id is published by the handler through res.locals once it exists.
        targetId: (req) => (typeof req.params.id === "string" ? req.params.id : null),
      },
      getAudit,
    ),
    async (req, res) => {
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
      res.locals.auditTargetId = transfer.id;
      res.locals.auditSummary = `transfer staged for setup ${id} (${body.targetNodeIds.length} target(s))`;
      res.status(202).json({ transfer });
    } catch (err) {
      if (err instanceof SetupNotFoundError) return res.status(404).json({ error: err.message });
      throw err;
    }
  });

  app.post(
    "/api/v1/setups/transfers/:id/cancel",
    audit({ action: "transfer.cancel", targetType: "transfer" }, getAudit),
    async (req, res) => {
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

  app.post(
    "/api/v1/bench/:type",
    audit(
      {
        action: "bench.start",
        targetType: "bench-run",
        targetId: () => null,
        summary: (req) => {
          const body: unknown = req.body;
          const nodeId = body && typeof body === "object" && "nodeId" in body && typeof body.nodeId === "string" ? body.nodeId : "?";
          return `benchmark started (${req.params.type ?? "?"}) on node ${nodeId}`;
        },
      },
      getAudit,
    ),
    async (req, res) => {
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
      res.locals.auditTargetId = run.id;
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

  app.post(
    "/api/v1/bench/runs/:id/cancel",
    audit({ action: "bench.cancel", targetType: "bench-run" }, getAudit),
    async (req, res) => {
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
      // root: see serveArtifact — a rootless absolute path 404s under a dot-dir.
      res.sendFile("index.html", { root: staticDir }, (err) => {
        if (err) next();
      });
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const e = err as { status?: number; type?: string; message?: string } | null;
    const status = e?.type === "entity.parse.failed" ? 400 : (e?.status ?? 500);
    // LAN-trust hub (ADR-0010 §8): a 5xx body carries the message so a fleet
    // operator can diagnose without shell access; stacks stay in the logs.
    console.error(`[500] ${_req.method} ${_req.path}:`, err);
    const body: Record<string, unknown> = { error: status >= 500 ? "internal server error" : "bad request" };
    if (status >= 500 && e instanceof Error && e.message) {
      // Drizzle wraps the driver error — walk to the deepest cause (the pg
      // message names the real failure: missing column, enum, connection…).
      let msg = e.message;
      let cause: unknown = e.cause;
      for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
        msg = cause.message;
        cause = cause.cause;
      }
      body.detail = `${e.message.slice(0, 160)} :: ${msg.slice(0, 200)}`;
    }
    res.status(status).json(body);
  });

  return app;
}

function toNodeDto(row: NodeRecord, online: boolean, expectedBundleSha256: string | null = null): NodeInfo {
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
    cacheUser: row.cacheUser,
    // IRI-068 / IRI-124: clock-cap state must reach the client, otherwise the
    // controls re-seed as "no cap" after every navigation.
    gpuClockCapMHz: row.gpuClockCapMHz,
    gpuClockCapPersistent: row.gpuClockCapPersistent,
    cpuClockCapMHz: row.cpuClockCapMHz,
    cpuClockCapPersistent: row.cpuClockCapPersistent,
    // IR-260: bundle generation state — running = agent-reported hash.
    bundle: bundleState(row.bundleSha256 ?? null, expectedBundleSha256),
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
