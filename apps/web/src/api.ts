import {
  type AnalyticsResponse,
  type TokenReconciliation,
  type EfficiencyResponse,
  type EfficiencyRow,
  type HealthFinding,
  type UsageRetriesResponse,
  type UsageTrace,
  usageRetriesResponseSchema,
  auditPageSchema,
  eventJournalPageSchema,
  logPageSchema,
  logSummarySchema,
  type AuditActor,
  type AuditPage,
  type AuditRange,
  type EventJournalPageWire,
  type LogPage,
  type LogQuery,
  type LogScope,
  type LogSource,
  type LogLevel,
  type LogSummary,
  clientIdentityCreatedSchema,
  chatDetailSchema,
  chatsResponseSchema,
  hfTokenStatusSchema,
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
  energyCostResponseSchema,
  tokenCostResponseSchema,
  type EnergyCost,
  type EnergyCostInput,
  type TokenCost,
  type TokenCostInput,
  type ClientIdentityCreated,
  type ChatDetail,
  type ChatsResponse,
  type HfTokenPut,
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

/** IRI-068: arm (step 1) or confirm (step 2) a node shutdown. */
export async function shutdownNode(id: string, confirmToken?: string): Promise<{ armed: boolean; confirmToken?: string; scheduled?: boolean }> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}/shutdown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(confirmToken === undefined ? {} : { confirmToken, origin: "web" }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body !== null && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as { armed: boolean; confirmToken?: string; scheduled?: boolean };
}

/** IRI-068: wake a shut-off node via WoL (uses the stored wolMac). */
export async function wakeNode(id: string): Promise<void> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}/wake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const msg = body !== null && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
}

/** IRI-068: apply (null = clear) the GPU clock cap; optionally persist via oneshot. */
export async function setClockCap(id: string, capMHz: number | null, persistent: boolean): Promise<void> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}/clock-cap`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capMHz, persistent }),
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const msg = body !== null && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
}

/** IRI-076: retry waste groups (superseded attempts per client key). */
export type { UsageRetriesResponse } from "@irori/core";
export async function fetchUsageRetries(range: UsageRangeName, opts: { nodeId?: string; signal?: AbortSignal } = {}): Promise<UsageRetriesResponse> {
  const res = await fetch(`/api/v1/usage/retries?${rangeQuery(range, opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {})}`, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`GET /api/v1/usage/retries failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  const parsed = usageRetriesResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/usage/retries: unexpected shape");
  return parsed.data;
}

/** IRI-080: per-node version provenance + drift (server response). */
export interface NodeVersionsResponse {
  agentVersion: string | null;
  pin: string | null;
  versions: {
    nodeRuntime: string | null;
    uv: string | null;
    catalog: { schema: number; generatedAt: string | null } | null;
    scripts: Array<{ path: string; present: boolean; executable: boolean; mtimeMs: number | null }>;
  } | null;
  drift: Array<{ user: string; modelctlVersion: string | null; belowPin: boolean }>;
  updatedAt: string | null;
}

/** IRI-080: per-node version provenance + drift. */
export async function fetchNodeVersions(id: string, signal?: AbortSignal): Promise<NodeVersionsResponse> {
  const res = await fetch(`/api/v1/nodes/${encodeURIComponent(id)}/versions`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/nodes/${id}/versions failed: HTTP ${res.status}`);
  return (await res.json()) as NodeVersionsResponse;
}

/** IRI-079: normalized span tree for the drawer's Trace tab. */
export async function fetchRequestTrace(id: string, signal?: AbortSignal): Promise<UsageTrace> {
  const res = await fetch(`/api/v1/usage/requests/${encodeURIComponent(id)}/trace`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET trace failed: HTTP ${res.status}`);
  return (await res.json()) as UsageTrace;
}

/** IRI-073: Wh-per-token efficiency (energy × ledger join). */
export async function fetchEfficiency(range: AnalyticsRangeName, groupBy: "node" | "model"): Promise<EfficiencyResponse> {
  const res = await fetch(`/api/v1/analytics/efficiency?range=${encodeURIComponent(range)}&groupBy=${groupBy}`);
  if (!res.ok) throw new Error(`GET /api/v1/analytics/efficiency failed: HTTP ${res.status}`);
  return (await res.json()) as EfficiencyResponse;
}

/** IRI-071: ledger vs capture token reconciliation. */
export async function fetchTokenReconciliation(range: AnalyticsRangeName): Promise<TokenReconciliation> {
  const res = await fetch(`/api/v1/analytics/token-reconciliation?range=${encodeURIComponent(range)}`);
  if (!res.ok) throw new Error(`GET /api/v1/analytics/token-reconciliation failed: HTTP ${res.status}`);
  return (await res.json()) as TokenReconciliation;
}

/** IRI-069: open health findings (per node). */
export type { HealthFinding } from "@irori/core";
export async function fetchHealthFindings(): Promise<HealthFinding[]> {
  const res = await fetch("/api/v1/health/findings");
  if (!res.ok) throw new Error(`GET /api/v1/health/findings failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !Array.isArray((body as { findings?: unknown }).findings)) {
    throw new Error("GET /api/v1/health/findings: expected {findings: []}");
  }
  return (body as { findings: HealthFinding[] }).findings;
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

export type HistoryRange = "30m" | "1h" | "4h" | "24h" | "7d" | "30d" | "90d";

export const HISTORY_RANGES: readonly HistoryRange[] = [
  "30m",
  "1h",
  "4h",
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
export type AnalyticsRangeName = "30m" | "1h" | "4h" | "24h" | "7d" | "30d" | "90d";

/** Tolerant: identity fields validated, series shape checked structurally. */
export async function fetchAnalytics(
  lens: AnalyticsLensName,
  range: AnalyticsRangeName,
  groupBy: "cluster" | "node" | "setup",
  opts: { setupId?: string; nodeId?: string; offsetMs?: number; signal?: AbortSignal } = {},
): Promise<AnalyticsResponse> {
  const params = new URLSearchParams({ range, groupBy });
  if (opts.setupId !== undefined) params.set("setupId", opts.setupId);
  if (opts.nodeId !== undefined) params.set("nodeId", opts.nodeId);
  if (opts.offsetMs !== undefined) params.set("offsetMs", String(opts.offsetMs));
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

/** IR-87: the hub snapshot cadence. null = unset (env default governs). */
export async function fetchCadenceMs(signal?: AbortSignal): Promise<number | null> {
  const res = await fetch("/api/v1/settings/cadence-ms", { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/settings/cadence-ms failed: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || !("cadenceMs" in body)) {
    throw new Error("malformed cadence payload");
  }
  const value = (body as { cadenceMs: unknown }).cadenceMs;
  return typeof value === "number" ? value : null;
}

export async function putCadenceMs(cadenceMs: number): Promise<void> {
  const res = await fetch("/api/v1/settings/cadence-ms", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cadenceMs }),
  });
  if (!res.ok) throw new Error(`PUT /api/v1/settings/cadence-ms failed: HTTP ${res.status}`);
}

/** IRI-025: energy + token cost settings. null = not configured. */
export async function fetchEnergyCost(signal?: AbortSignal): Promise<EnergyCost | null> {
  const res = await fetch("/api/v1/settings/energy-cost", { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/settings/energy-cost failed: HTTP ${res.status}`);
  const parsed = energyCostResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("malformed energy cost payload");
  return parsed.data.energyCost;
}

export async function putEnergyCost(cost: EnergyCostInput): Promise<void> {
  const res = await fetch("/api/v1/settings/energy-cost", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cost),
  });
  if (!res.ok) throw new Error(`PUT /api/v1/settings/energy-cost failed: HTTP ${res.status}`);
}

export async function fetchTokenCost(signal?: AbortSignal): Promise<TokenCost | null> {
  const res = await fetch("/api/v1/settings/token-cost", { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`GET /api/v1/settings/token-cost failed: HTTP ${res.status}`);
  const parsed = tokenCostResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("malformed token cost payload");
  return parsed.data.tokenCost;
}

export async function putTokenCost(cost: TokenCostInput): Promise<void> {
  const res = await fetch("/api/v1/settings/token-cost", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cost),
  });
  if (!res.ok) throw new Error(`PUT /api/v1/settings/token-cost failed: HTTP ${res.status}`);
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

/* ── Hub settings: global HF token (IRI-019) ───────────────────────────── */

/** Throws the server's `{error}` message when present, else a status error. */
async function throwApiError(res: Response, label: string): Promise<never> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string") {
    throw new Error((body as { error: string }).error);
  }
  throw new Error(`${label} failed: HTTP ${res.status}`);
}

/** Whether a global HF token is configured. Presence-only — never the token. */
export async function fetchHfTokenStatus(signal?: AbortSignal): Promise<boolean> {
  const res = await fetch("/api/v1/settings/hf-token", { headers: { accept: "application/json" }, signal });
  if (!res.ok) await throwApiError(res, "GET /api/v1/settings/hf-token");
  const body: unknown = await res.json();
  const parsed = hfTokenStatusSchema.safeParse(body);
  if (!parsed.success) throw new Error("GET /api/v1/settings/hf-token: unexpected shape");
  return parsed.data.configured;
}

/** Sets (string) or clears (null) the hub-wide HF token; the hub pushes it to online agents. */
export async function putHfToken(token: string | null): Promise<void> {
  const res = await fetch("/api/v1/settings/hf-token", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hfToken: token } satisfies HfTokenPut),
  });
  if (!res.ok) await throwApiError(res, "PUT /api/v1/settings/hf-token");
}

/* ── Audit log + event journal (IRI-077) ──────────────────────────────── */

export interface AuditFilters {
  range: AuditRange;
  actor?: AuditActor;
  domain?: string;
  targetId?: string;
  q?: string;
  cursor?: string;
}

/** One page of the durable audit record; `nextCursor` null = last page. */
export async function fetchAudit(filters: AuditFilters, signal?: AbortSignal): Promise<AuditPage> {
  const params = new URLSearchParams({ range: filters.range });
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.domain) params.set("domain", filters.domain);
  if (filters.targetId) params.set("targetId", filters.targetId);
  if (filters.q) params.set("q", filters.q);
  if (filters.cursor) params.set("cursor", filters.cursor);
  const res = await fetch(`/api/v1/audit?${params.toString()}`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) await throwApiError(res, "GET /api/v1/audit");
  const parsed = auditPageSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("GET /api/v1/audit: unexpected shape");
  return parsed.data;
}

export interface JournalFilters {
  range: "1h" | "24h" | "7d" | "30d";
  type?: string;
  nodeId?: string;
  limit?: number;
  cursor?: number;
}

/** Restart-surviving operational frames (the live feed ring has no history). */
export async function fetchEventJournal(filters: JournalFilters, signal?: AbortSignal): Promise<EventJournalPageWire> {
  const params = new URLSearchParams({ range: filters.range });
  if (filters.type) params.set("type", filters.type);
  if (filters.nodeId) params.set("nodeId", filters.nodeId);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.cursor !== undefined) params.set("cursor", String(filters.cursor));
  const res = await fetch(`/api/v1/events/journal?${params.toString()}`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) await throwApiError(res, "GET /api/v1/events/journal");
  const parsed = eventJournalPageSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("GET /api/v1/events/journal: unexpected shape");
  return parsed.data;
}

/* ── Durable logs (IRI-078) ───────────────────────────────────────────── */

export interface LogFilters {
  range: LogQuery["range"];
  nodeId?: string;
  setupId?: string;
  runId?: string;
  jobId?: string;
  scope?: LogScope;
  source?: LogSource;
  /** Inclusive minimum level. */
  level?: LogLevel;
  q?: string;
  /** Backward pagination (id < cursor, newest first). */
  cursor?: string;
  /** Live-tail delta (id > after, ascending). */
  after?: string;
}

function logParams(filters: LogFilters): URLSearchParams {
  const params = new URLSearchParams({ range: filters.range });
  if (filters.nodeId) params.set("nodeId", filters.nodeId);
  if (filters.setupId) params.set("setupId", filters.setupId);
  if (filters.runId) params.set("runId", filters.runId);
  if (filters.jobId) params.set("jobId", filters.jobId);
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.source) params.set("source", filters.source);
  if (filters.level) params.set("level", filters.level);
  if (filters.q) params.set("q", filters.q);
  if (filters.cursor) params.set("cursor", filters.cursor);
  if (filters.after) params.set("after", filters.after);
  return params;
}

/** One page of the durable log record; `nextCursor` null = last page. */
export async function fetchLogs(filters: LogFilters, signal?: AbortSignal): Promise<LogPage> {
  const res = await fetch(`/api/v1/logs?${logParams(filters).toString()}`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) await throwApiError(res, "GET /api/v1/logs");
  const parsed = logPageSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("GET /api/v1/logs: unexpected shape");
  return parsed.data;
}

/** Counts per level for the filter-bar chips (same filters, no paging). */
export async function fetchLogSummary(filters: Omit<LogFilters, "cursor" | "after">, signal?: AbortSignal): Promise<LogSummary> {
  const params = logParams(filters);
  params.delete("cursor");
  params.delete("after");
  const res = await fetch(`/api/v1/logs/summary?${params.toString()}`, { headers: { accept: "application/json" }, signal });
  if (!res.ok) await throwApiError(res, "GET /api/v1/logs/summary");
  const parsed = logSummarySchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("GET /api/v1/logs/summary: unexpected shape");
  return parsed.data;
}
