import { LOG_LEVELS, LOG_LEVEL_ORDER, type LogLevel, type LogQuery, type LogRow, type LogScope, type LogSource } from "@irori/core";
import type { LogFilters } from "./api";

/**
 * Pure helpers for the Logs view (IRI-078). Kept out of the SFC so the
 * load-bearing logic — hash round-trip, filter serialization, level chips —
 * has a real test layer (repo convention: web tests are pure-function +
 * source guards, no component mounting).
 */

export const LOG_RANGE_TABS: ReadonlyArray<{ value: LogQuery["range"]; label: string }> = [
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 h" },
  { value: "6h", label: "6 h" },
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
];

export const LOG_SCOPE_TABS: ReadonlyArray<{ value: LogScope | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "setup", label: "Setups" },
  { value: "job", label: "Jobs" },
  { value: "agent", label: "Agent" },
  { value: "proxy", label: "Proxy" },
  { value: "hub", label: "Hub" },
];

export const LOG_LEVEL_TABS: ReadonlyArray<{ value: LogLevel | "all"; label: string }> = LOG_LEVELS.map((l) => ({
  value: l,
  label: l === "trace" ? "Trace" : l === "debug" ? "Debug" : l === "info" ? "Info" : l === "warn" ? "Warn" : "Error",
}));

export const LOG_SOURCE_TABS: ReadonlyArray<{ value: LogSource | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "driver", label: "Driver" },
  { value: "engine", label: "Engine" },
  { value: "proxy", label: "Proxy" },
  { value: "system", label: "System" },
];

export interface LogFilterState {
  range: LogQuery["range"];
  nodeId: string;
  setupId: string;
  runId: string;
  jobId: string;
  scope: LogScope | "all";
  source: LogSource | "all";
  level: LogLevel | "all";
  q: string;
}

export const DEFAULT_LOG_FILTERS: LogFilterState = {
  range: "1h",
  nodeId: "",
  setupId: "",
  runId: "",
  jobId: "",
  scope: "all",
  source: "all",
  level: "all",
  q: "",
};

const isRange = (v: string | null): v is LogQuery["range"] => LOG_RANGE_TABS.some((t) => t.value === v);
const isScope = (v: string | null): v is LogScope | "all" => LOG_SCOPE_TABS.some((t) => t.value === v);
const isSource = (v: string | null): v is LogSource | "all" => LOG_SOURCE_TABS.some((t) => t.value === v);
const isLevel = (v: string | null): v is LogLevel | "all" => LOG_LEVEL_TABS.some((t) => t.value === v);

/** Parses `#/logs?range=…&node=…&setup=…&run=…&job=…&scope=…&source=…&level=…&q=…`. */
export function parseLogsHash(hash: string): LogFilterState {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = h.startsWith("/logs?") ? h.slice("/logs?".length) : "";
  const params = new URLSearchParams(q);
  const range = params.get("range");
  const scope = params.get("scope");
  const source = params.get("source");
  const level = params.get("level");
  return {
    range: isRange(range) ? range : DEFAULT_LOG_FILTERS.range,
    nodeId: (params.get("node") ?? "").slice(0, 64),
    setupId: (params.get("setup") ?? "").slice(0, 64),
    runId: (params.get("run") ?? "").slice(0, 64),
    jobId: (params.get("job") ?? "").slice(0, 64),
    scope: isScope(scope) ? scope : "all",
    source: isSource(source) ? source : "all",
    level: isLevel(level) ? level : "all",
    q: (params.get("q") ?? "").slice(0, 128),
  };
}

export function logsHashFor(filters: Partial<LogFilterState>): string {
  const params = new URLSearchParams();
  if (filters.range) params.set("range", filters.range);
  if (filters.nodeId) params.set("node", filters.nodeId);
  if (filters.setupId) params.set("setup", filters.setupId);
  if (filters.runId) params.set("run", filters.runId);
  if (filters.jobId) params.set("job", filters.jobId);
  if (filters.scope && filters.scope !== "all") params.set("scope", filters.scope);
  if (filters.source && filters.source !== "all") params.set("source", filters.source);
  if (filters.level && filters.level !== "all") params.set("level", filters.level);
  if (filters.q) params.set("q", filters.q);
  const s = params.toString();
  return s.length > 0 ? `#/logs?${s}` : "#/logs";
}

/** Per-entity deep link: Logs filtered to one setup (and its latest run). */
export function logsSetupHash(setupId: string, runId: string | null = null): string {
  return logsHashFor({ setupId, ...(runId !== null ? { runId } : {}) });
}

export function logsNodeHash(nodeId: string): string {
  return logsHashFor({ nodeId });
}

/** Server filter mapping: "all" tabs drop out, level is the inclusive min. */
export function serverLogFilters(f: LogFilterState): Omit<LogFilters, "range" | "cursor" | "after"> {
  const out: Omit<LogFilters, "range" | "cursor" | "after"> = {};
  if (f.nodeId) out.nodeId = f.nodeId;
  if (f.setupId) out.setupId = f.setupId;
  if (f.runId) out.runId = f.runId;
  if (f.jobId) out.jobId = f.jobId;
  if (f.scope !== "all") out.scope = f.scope;
  if (f.source !== "all") out.source = f.source;
  if (f.level !== "all") out.level = f.level;
  if (f.q.trim()) out.q = f.q.trim();
  return out;
}

/** Tailwind-free chip class per level (theme tokens; error/warn pop). */
export function levelChipClass(level: LogLevel): string {
  return level === "error" ? "chip chip--error" : level === "warn" ? "chip chip--warn" : "chip";
}

/** Severity rank for row tinting (CSS var pick). */
export function levelRank(level: LogLevel): number {
  return LOG_LEVEL_ORDER[level];
}

/** HH:MM:SS from the row's ingest ts (event wall clock is advisory only). */
export function fmtLogTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function fmtLogDate(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${fmtLogTime(iso)}`;
}

/** One-line summary used by row expansion + the copy button. */
export function rowSummary(row: LogRow): string {
  const seq = row.seq !== null ? ` #${row.seq}` : "";
  return `${row.ts} ${row.scope}/${row.source}${seq} ${row.line}`;
}
