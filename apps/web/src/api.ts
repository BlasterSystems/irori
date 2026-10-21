import {
  type AnalyticsResponse,
  clientIdentityCreatedSchema,
  chatDetailSchema,
  chatsResponseSchema,
  LLM_BACKENDS,
  nodeInfoSchema,
  sseEventSchema,
  usageAgentsResponseSchema,
  usageClientsResponseSchema,
  usageErrorsResponseSchema,
  usageModelsResponseSchema,
  usageOverviewResponseSchema,
  usageRequestRowSchema,
  usageRequestsResponseSchema,
  usageToolsResponseSchema,
  USAGE_RANGES,
  type ClientIdentityCreated,
  type ChatDetail,
  type ChatsResponse,
  type LlmBackend,
  type LlmPortSnapshot,
  type NodeCreatePayload,
  type NodeInfo,
  type NodePatchPayload,
  type SseEvent,
  type UsageAgentsResponse,
  type UsageClientsResponse,
  type UsageErrorsResponse,
  type UsageModelsResponse,
  type UsageOverviewResponse,
  type UsageRequestRow,
  type UsageRequestsResponse,
  type UsageToolsResponse,
} from "@irori/core";

/** Registry entries carry the node's configured probe ports (M3); older
 *  server payloads omit the field, so it is re-attached from the raw body. */
function extractLlmPorts(raw: unknown): number[] {
  if (typeof raw !== "object" || raw === null || !("llmPorts" in raw)) return [];
  const ports: unknown = raw.llmPorts;
  if (!Array.isArray(ports)) return [];
  return ports.filter(
    (p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0,
  );
}

/**
 * Fetch the node registry. Tolerates extra fields: nodeInfoSchema strips
 * unknown keys (zod default), so newer servers stay compatible.
 */
export async function fetchNodes(signal?: AbortSignal): Promise<NodeInfo[]> {
  const res = await fetch("/api/v1/nodes", {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`GET /api/v1/nodes failed: HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) {
    throw new Error("GET /api/v1/nodes: expected a JSON array of nodes");
  }
  return body.map((item) => {
    const parsed = nodeInfoSchema.safeParse(item);
    if (parsed.success) return parsed.data;
    // One malformed node must not kill the whole registry view: parse the
    // identity strictly and sanitize the probe ports from the raw payload.
    const lenient = nodeInfoSchema.omit({ llmPorts: true }).parse(item);
    return { ...lenient, llmPorts: extractLlmPorts(item) };
  });
}

/* ── Node registry mutations (IRI-010) ────────────────────────────────── */

/** Parse the `{ node, token }` / `{ node }` envelope shape. */
function parseNodeEnvelope(
  endpoint: string,
  body: unknown,
  requireToken: boolean,
): { node: NodeInfo; token: string | null } {
  if (typeof body !== "object" || body === null) {
    throw new Error(`${endpoint}: expected an object`);
  }
  const { node, token } = body as { node?: unknown; token?: unknown };
  if (requireToken && typeof token !== "string") {
    throw new Error(`${endpoint}: expected a token string`);
  }
  return { node: nodeInfoSchema.parse(node), token: typeof token === "string" ? token : null };
}

/**
 * Create a node. The returned `token` is the agent's secret and is shown
 * exactly once — no other endpoint ever returns it.
 */
export async function createNode(
  input: NodeCreatePayload,
): Promise<{ node: NodeInfo; token: string }> {
  const res = await fetch("/api/v1/nodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`POST /api/v1/nodes failed: HTTP ${res.status}`);
  }
  const parsed = parseNodeEnvelope("POST /api/v1/nodes", await res.json(), true);
  return { node: parsed.node, token: parsed.token as string };
}

/** Patch a node. Only the keys present in `patch` are applied server-side. */
export async function patchNode(id: string, patch: NodePatchPayload): Promise<NodeInfo> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/v1/nodes/${id} failed: HTTP ${res.status}`);
  }
  return parseNodeEnvelope(`PATCH /api/v1/nodes/${id}`, await res.json(), false).node;
}

/** Delete a node (also drops its in-memory rings server-side). */
export async function deleteNode(id: string): Promise<void> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE /api/v1/nodes/${id} failed: HTTP ${res.status}`);
  }
}

/** Rotate a node's agent token. The old token fails at the agent's next hello. */
export async function rotateNodeToken(id: string): Promise<string> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}/token/rotate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`POST /api/v1/nodes/${id}/token/rotate failed: HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) {
    throw new Error(`POST /api/v1/nodes/${id}/token/rotate: expected an object`);
  }
  const { token } = body as { token?: unknown };
  if (typeof token !== "string") {
    throw new Error(`POST /api/v1/nodes/${id}/token/rotate: expected a token string`);
  }
  return token;
}

/* ── Node history ─────────────────────────────────────────────────────── */

export type HistoryRange = "1h" | "24h" | "7d" | "30d" | "90d";

export const HISTORY_RANGES: readonly HistoryRange[] = [
  "1h",
  "24h",
  "7d",
  "30d",
  "90d",
];

export function isHistoryRange(value: string): value is HistoryRange {
  return (HISTORY_RANGES as readonly string[]).includes(value);
}

/** min/avg/max band (°C); each side nullable when the collector missed it. */
export interface TempBand {
  min: number | null;
  avg: number | null;
  max: number | null;
}

/**
 * One server-side history bucket, ascending by `t`. Usage %, watts and
 * bytes/s rates as collected; `mem`/`gpuMem` are absolute bytes (bucket
 * average, gpuMem summed across cards). Null = collector could not read it.
 */
export interface HistoryPoint {
  t: number;
  cpu: number | null;
  cpuTemp: TempBand;
  mem: number | null;
  gpu: number | null;
  gpuTemp: TempBand;
  gpuPowerW: number | null;
  gpuMem: number | null;
  netRx: number | null;
  netTx: number | null;
  samples: number | null;
}

export interface HistoryResponse {
  /** Server bucket size, verbatim DB enum: "minute" | "hour" | "day". */
  granularity: string;
  points: HistoryPoint[];
}

function isNumOrNull(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

function parseTempBand(v: unknown, field: string): TempBand {
  if (typeof v !== "object" || v === null) {
    throw new Error(`history: ${field} must be an object`);
  }
  const o = v as Record<string, unknown>;
  if (!isNumOrNull(o.min) || !isNumOrNull(o.avg) || !isNumOrNull(o.max)) {
    throw new Error(`history: ${field}.min/avg/max must be numbers or null`);
  }
  return { min: o.min, avg: o.avg, max: o.max };
}

/**
 * Validate a history payload. Hand-rolled (zod is not a web dependency) and
 * strict on shape but tolerant of unknown keys, like the rest of the client.
 */
export function parseHistoryResponse(body: unknown): HistoryResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("history: expected a JSON object");
  }
  const o = body as Record<string, unknown>;
  if (typeof o.granularity !== "string" || o.granularity.length === 0) {
    throw new Error("history: granularity must be a string");
  }
  if (!Array.isArray(o.points)) {
    throw new Error("history: points must be an array");
  }
  const points = o.points.map((raw): HistoryPoint => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("history: point must be an object");
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.t !== "number") {
      throw new Error("history: point.t must be a number");
    }
    for (const k of [
      "cpu",
      "mem",
      "gpu",
      "gpuPowerW",
      "gpuMem",
      "netRx",
      "netTx",
      "samples",
    ] as const) {
      if (!isNumOrNull(p[k])) {
        throw new Error(`history: point.${k} must be a number or null`);
      }
    }
    return {
      t: p.t,
      cpu: p.cpu as number | null,
      cpuTemp: parseTempBand(p.cpuTemp, "cpuTemp"),
      mem: p.mem as number | null,
      gpu: p.gpu as number | null,
      gpuTemp: parseTempBand(p.gpuTemp, "gpuTemp"),
      gpuPowerW: p.gpuPowerW as number | null,
      gpuMem: p.gpuMem as number | null,
      netRx: p.netRx as number | null,
      netTx: p.netTx as number | null,
      samples: p.samples as number | null,
    };
  });
  return { granularity: o.granularity, points };
}

export async function fetchHistory(
  nodeId: string,
  range: HistoryRange,
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  const res = await fetch(
    `/api/v1/nodes/${encodeURIComponent(nodeId)}/history?range=${range}`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!res.ok) {
    throw new Error(
      `GET /api/v1/nodes/${nodeId}/history failed: HTTP ${res.status}`,
    );
  }
  const body: unknown = await res.json();
  return parseHistoryResponse(body);
}

/* ── Node LLM inference ───────────────────────────────────────────────── */

export interface LlmSnapshot {
  ports: LlmPortSnapshot[];
  /** Server receive time of the last probe (ISO), empty when absent. */
  updatedAt: string;
}

function nullableString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new Error(`llm: port.${key} must be a string or null`);
  }
  return v;
}

function nullableNumber(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`llm: port.${key} must be a number or null`);
  }
  return v;
}

/** One port snapshot with the schema's defaults applied to absent fields. */
function parseLlmPort(raw: unknown): LlmPortSnapshot {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("llm: port must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.port !== "number" || !Number.isInteger(o.port) || o.port <= 0) {
    throw new Error("llm: port.port must be a positive integer");
  }
  if (typeof o.backend !== "string" || !(LLM_BACKENDS as readonly string[]).includes(o.backend)) {
    throw new Error("llm: port.backend must be a known backend");
  }
  if (typeof o.detected !== "boolean") {
    throw new Error("llm: port.detected must be a boolean");
  }
  if (
    o.probedAtMs !== undefined &&
    (typeof o.probedAtMs !== "number" || o.probedAtMs < 0)
  ) {
    throw new Error("llm: port.probedAtMs must be a non-negative number");
  }
  let engineMeta: Record<string, unknown> | null = null;
  if (o.engineMeta !== null && o.engineMeta !== undefined) {
    if (typeof o.engineMeta !== "object" || Array.isArray(o.engineMeta)) {
      throw new Error("llm: port.engineMeta must be an object or null");
    }
    engineMeta = o.engineMeta as Record<string, unknown>;
  }
  return {
    port: o.port,
    host: nullableString(o, "host") ?? "127.0.0.1",
    backend: o.backend as LlmBackend,
    detected: o.detected,
    model: nullableString(o, "model"),
    decodeTps: nullableNumber(o, "decodeTps"),
    prefillTps: nullableNumber(o, "prefillTps"),
    queueRunning: nullableNumber(o, "queueRunning"),
    queueWaiting: nullableNumber(o, "queueWaiting"),
    kvCachePct: nullableNumber(o, "kvCachePct"),
    ttftP95Ms: nullableNumber(o, "ttftP95Ms"),
    e2eP95Ms: nullableNumber(o, "e2eP95Ms"),
    itlP95Ms: nullableNumber(o, "itlP95Ms"),
    engineMeta,
    tokens: shapeTokens(o.tokens),
    probedAtMs: typeof o.probedAtMs === "number" ? o.probedAtMs : 0,
  };
}

/** Cumulative token counters (M7): tolerate absent/garbage payloads. */
function shapeTokens(raw: unknown): LlmPortSnapshot["tokens"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    generated: nullableNumber(o, "generated"),
    prompt: nullableNumber(o, "prompt"),
    cached: nullableNumber(o, "cached"),
  };
}

/**
 * Validate a GET /nodes/:id/llm payload. Hand-rolled (zod is not a web
 * dependency), strict on identity fields, tolerant of absent optionals.
 */
export function parseLlmSnapshot(body: unknown): LlmSnapshot {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("llm: expected a JSON object");
  }
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.ports)) {
    throw new Error("llm: ports must be an array");
  }
  return {
    ports: o.ports.map(parseLlmPort),
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : "",
  };
}

export async function fetchNodeLlm(
  nodeId: string,
  signal?: AbortSignal,
): Promise<LlmSnapshot> {
  const res = await fetch(
    `/api/v1/nodes/${encodeURIComponent(nodeId)}/llm`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!res.ok) {
    throw new Error(`GET /api/v1/nodes/${nodeId}/llm failed: HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  return parseLlmSnapshot(body);
}

/** One server-side per-port LLM history bucket, ascending by `t`. */
export interface LlmHistoryPoint {
  t: number;
  decodeTps: number | null;
  prefillTps: number | null;
  queueRunning: number | null;
  queueWaiting: number | null;
  kvCachePct: number | null;
  ttftP95Ms: number | null;
  samples: number | null;
}

export interface LlmHistorySeries {
  port: number;
  points: LlmHistoryPoint[];
}

export interface LlmHistoryResponse {
  /** Server bucket size, verbatim DB enum: "minute" | "hour" | "day". */
  granularity: string;
  series: LlmHistorySeries[];
}

/**
 * Validate a GET /nodes/:id/llm/history payload. Hand-rolled like
 * parseHistoryResponse: strict on shape, tolerant of unknown keys.
 */
export function parseLlmHistoryResponse(body: unknown): LlmHistoryResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("llm history: expected a JSON object");
  }
  const o = body as Record<string, unknown>;
  if (typeof o.granularity !== "string" || o.granularity.length === 0) {
    throw new Error("llm history: granularity must be a string");
  }
  if (!Array.isArray(o.series)) {
    throw new Error("llm history: series must be an array");
  }
  const series = o.series.map((raw): LlmHistorySeries => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("llm history: series must be an object");
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port <= 0) {
      throw new Error("llm history: series.port must be a positive integer");
    }
    if (!Array.isArray(s.points)) {
      throw new Error("llm history: series.points must be an array");
    }
    const points = s.points.map((rawPoint): LlmHistoryPoint => {
      if (typeof rawPoint !== "object" || rawPoint === null) {
        throw new Error("llm history: point must be an object");
      }
      const p = rawPoint as Record<string, unknown>;
      if (typeof p.t !== "number") {
        throw new Error("llm history: point.t must be a number");
      }
      for (const k of [
        "decodeTps",
        "prefillTps",
        "queueRunning",
        "queueWaiting",
        "kvCachePct",
        "ttftP95Ms",
        "samples",
      ] as const) {
        if (!isNumOrNull(p[k])) {
          throw new Error(`llm history: point.${k} must be a number or null`);
        }
      }
      return {
        t: p.t,
        decodeTps: p.decodeTps as number | null,
        prefillTps: p.prefillTps as number | null,
        queueRunning: p.queueRunning as number | null,
        queueWaiting: p.queueWaiting as number | null,
        kvCachePct: p.kvCachePct as number | null,
        ttftP95Ms: p.ttftP95Ms as number | null,
        samples: p.samples as number | null,
      };
    });
    return { port: s.port, points };
  });
  return { granularity: o.granularity, series };
}

export async function fetchLlmHistory(
  nodeId: string,
  range: HistoryRange,
  signal?: AbortSignal,
): Promise<LlmHistoryResponse> {
  const res = await fetch(
    `/api/v1/nodes/${encodeURIComponent(nodeId)}/llm/history?range=${range}`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!res.ok) {
    throw new Error(
      `GET /api/v1/nodes/${nodeId}/llm/history failed: HTTP ${res.status}`,
    );
  }
  const body: unknown = await res.json();
  return parseLlmHistoryResponse(body);
}

// ─── M7: analytics + cleanup ────────────────────────────────────────────────

export type AnalyticsLensName = "memory" | "decode" | "power" | "temps" | "tokens";
export type AnalyticsRangeName = "1h" | "24h" | "7d" | "30d" | "90d";

/** Tolerant: identity fields validated, series shape checked structurally. */
export async function fetchAnalytics(
  lens: AnalyticsLensName,
  range: AnalyticsRangeName,
  groupBy: "cluster" | "node",
  opts: { setupId?: string; nodeId?: string; signal?: AbortSignal } = {},
): Promise<AnalyticsResponse> {
  const params = new URLSearchParams({ range, groupBy });
  if (opts.setupId !== undefined) params.set("setupId", opts.setupId);
  if (opts.nodeId !== undefined) params.set("nodeId", opts.nodeId);
  const res = await fetch(`/api/v1/analytics/${lens}?${params}`, { headers: { accept: "application/json" }, signal: opts.signal });
  if (!res.ok) throw new Error(`GET /api/v1/analytics/${lens} failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("GET /api/v1/analytics: expected an object");
  }
  const o = body as Record<string, unknown>;
  if (o.lens !== lens || o.range !== range || o.groupBy !== groupBy || !Array.isArray(o.series)) {
    throw new Error("GET /api/v1/analytics: unexpected payload shape");
  }
  return body as AnalyticsResponse;
}

export interface CleanupCategoryAudit {
  category: string;
  safe: boolean;
  rationale: string;
  itemCount: number;
  reclaimableBytes: number;
}

export interface CleanupAuditReport {
  generatedAtMs: number;
  totalBytes: number | null;
  freeBytes: number | null;
  categories: CleanupCategoryAudit[];
}

export interface CleanupHistoryEntry {
  id: string;
  kind: string;
  status: string;
  categories: unknown;
  report: unknown;
  error: string | null;
  jobId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CleanupRunRow {
  id: string;
  kind: string;
  status: string;
  categories: unknown;
  /** HygieneAudit / HygieneCleanResult — null until the job settles. */
  report: CleanupAuditReport | Record<string, unknown> | null;
  error: string | null;
  jobId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CleanupState {
  latestAudit: CleanupRunRow | null;
  history: CleanupRunRow[];
  prevention: { weeklySafePass: boolean; logRotationApplied: boolean };
}

export async function fetchCleanup(nodeId: string, signal?: AbortSignal): Promise<CleanupState> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/cleanup`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/nodes/${nodeId}/cleanup failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("GET cleanup: expected an object");
  }
  const o = body as Record<string, unknown>;
  return {
    latestAudit: (o.latestAudit ?? null) as CleanupState["latestAudit"],
    history: Array.isArray(o.history) ? (o.history as CleanupState["history"]) : [],
    prevention: (o.prevention ?? { weeklySafePass: false, logRotationApplied: false }) as CleanupState["prevention"],
  };
}

export async function setWeeklySafePass(nodeId: string, enabled: boolean): Promise<CleanupState["prevention"]> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(nodeId)}/hygiene`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ weeklySafePass: enabled }),
  });
  if (!res.ok) throw new Error(`PUT /api/v1/nodes/${nodeId}/hygiene failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  return (typeof body === "object" && body !== null ? body : {}) as CleanupState["prevention"];
}

// ─── IRI-013: overview event feed ───────────────────────────────────────────

/** Feed history for a freshly loaded page; unknown frames are dropped. */
export async function fetchEventsRecent(limit = 200, signal?: AbortSignal): Promise<SseEvent[]> {
  const res = await fetch(`/api/v1/events/recent?limit=${limit}`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/events/recent failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("GET /api/v1/events/recent: expected an object");
  }
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  return events.flatMap((e) => {
    const parsed = sseEventSchema.safeParse(e);
    return parsed.success ? [parsed.data] : [];
  });
}

// ---- M8: usage capture (ADR-0008) ----

export type UsageRangeName = (typeof USAGE_RANGES)[number];

function rangeQuery(range: UsageRangeName, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ range, ...extra });
  return params.toString();
}

export async function fetchUsageOverview(
  range: UsageRangeName,
  opts: { nodeId?: string; model?: string; signal?: AbortSignal } = {},
): Promise<UsageOverviewResponse> {
  const extra: Record<string, string> = {};
  if (opts.nodeId !== undefined) extra.nodeId = opts.nodeId;
  if (opts.model !== undefined) extra.model = opts.model;
  const res = await fetch(`/api/v1/usage/overview?${rangeQuery(range, extra)}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/usage/overview failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageOverviewResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/overview: unexpected shape");
  return parsed.data;
}

export async function fetchUsageRequests(
  range: UsageRangeName,
  opts: { nodeId?: string; model?: string; errorOnly?: boolean; sig?: string; status?: number; project?: string; agentType?: string; page?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<UsageRequestsResponse> {
  const extra: Record<string, string> = {};
  if (opts.nodeId !== undefined) extra.nodeId = opts.nodeId;
  if (opts.model !== undefined) extra.model = opts.model;
  if (opts.errorOnly === true) extra.errors = "1";
  if (opts.sig !== undefined) extra.sig = opts.sig;
  if (opts.status !== undefined) extra.status = String(opts.status);
  if (opts.project !== undefined) extra.project = opts.project;
  if (opts.agentType !== undefined) extra.agentType = opts.agentType;
  if (opts.page !== undefined) extra.page = String(opts.page);
  if (opts.limit !== undefined) extra.limit = String(opts.limit);
  const res = await fetch(`/api/v1/usage/requests?${rangeQuery(range, extra)}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/usage/requests failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageRequestsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/requests: unexpected shape");
  return parsed.data;
}

export async function fetchUsageRequest(id: string, signal?: AbortSignal): Promise<UsageRequestRow | null> {
  const res = await fetch(`/api/v1/usage/requests/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/v1/usage/requests/${id} failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageRequestRowSchema.safeParse(body);
  if (!parsed.success) throw new Error(`GET /api/v1/usage/requests/${id}: unexpected shape`);
  return parsed.data;
}

export async function fetchUsageErrors(
  range: UsageRangeName,
  opts: { nodeId?: string; model?: string; signal?: AbortSignal } = {},
): Promise<UsageErrorsResponse> {
  const extra: Record<string, string> = {};
  if (opts.nodeId !== undefined) extra.nodeId = opts.nodeId;
  if (opts.model !== undefined) extra.model = opts.model;
  const res = await fetch(`/api/v1/usage/errors?${rangeQuery(range, extra)}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/usage/errors failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageErrorsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/errors: unexpected shape");
  return parsed.data;
}

export async function fetchUsageModels(
  range: UsageRangeName,
  opts: { nodeId?: string; signal?: AbortSignal } = {},
): Promise<UsageModelsResponse> {
  const res = await fetch(`/api/v1/usage/models?${rangeQuery(range, opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {})}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/usage/models failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageModelsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/models: unexpected shape");
  return parsed.data;
}

export async function fetchUsageAgents(
  range: UsageRangeName,
  opts: { nodeId?: string; signal?: AbortSignal } = {},
): Promise<UsageAgentsResponse> {
  const res = await fetch(`/api/v1/usage/agents?${rangeQuery(range, opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {})}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/usage/agents failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageAgentsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/agents: unexpected shape");
  return parsed.data;
}

export async function fetchUsageTools(
  range: UsageRangeName,
  opts: { nodeId?: string; model?: string; signal?: AbortSignal } = {},
): Promise<UsageToolsResponse> {
  const extra: Record<string, string> = {};
  if (opts.nodeId !== undefined) extra.nodeId = opts.nodeId;
  if (opts.model !== undefined) extra.model = opts.model;
  const res = await fetch(`/api/v1/usage/tools?${rangeQuery(range, extra)}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/usage/tools failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageToolsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/tools: unexpected shape");
  return parsed.data;
}

export async function fetchUsageClients(signal?: AbortSignal): Promise<UsageClientsResponse> {
  const res = await fetch(`/api/v1/usage/clients`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/usage/clients failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageClientsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/clients: unexpected shape");
  return parsed.data;
}

export async function createUsageClient(input: { name: string; project?: string; agentType?: string }): Promise<ClientIdentityCreated> {
  const res = await fetch(`/api/v1/usage/clients`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`POST /api/v1/usage/clients failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = clientIdentityCreatedSchema.safeParse(body);
  if (!parsed.success) throw new Error("POST /api/v1/usage/clients: unexpected shape");
  return parsed.data;
}

export async function deleteUsageClient(id: string): Promise<void> {
  const res = await fetch(`/api/v1/usage/clients/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE /api/v1/usage/clients failed: HTTP ${res.status}`);
}

export async function fetchChats(
  range: UsageRangeName,
  opts: { nodeId?: string; signal?: AbortSignal } = {},
): Promise<ChatsResponse> {
  const res = await fetch(`/api/v1/usage/chats?${rangeQuery(range, opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {})}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/usage/chats failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = chatsResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/chats: unexpected shape");
  return parsed.data;
}

export async function fetchChat(id: string, signal?: AbortSignal): Promise<ChatDetail | null> {
  const res = await fetch(`/api/v1/usage/chats/${encodeURIComponent(id)}`, { headers: { accept: "application/json" }, signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /api/v1/usage/chats/${id} failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = chatDetailSchema.safeParse(body);
  if (!parsed.success) throw new Error(`GET /api/v1/usage/chats/${id}: unexpected shape`);
  return parsed.data;
}
