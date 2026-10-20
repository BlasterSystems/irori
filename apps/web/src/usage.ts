import { sparklinePath } from "./sparkline";
import type { UsageEvent, UsageErrorsResponse, UsageModelsResponse, UsageOverviewResponse, UsageRequestRow, UsageRequestsResponse } from "@irori/core";
import type { LensChart } from "./analytics";

/**
 * Usage view-model (M8): pure helpers for the four Usage pages — formatters,
 * URL state, chart geometry, table cell mappers. DOM-free and unit-tested.
 */

export const USAGE_TABS = ["overview", "requests", "errors", "models"] as const;
export type UsageTab = (typeof USAGE_TABS)[number];

export const USAGE_RANGE_TABS: Array<{ value: UsageOverviewResponse["range"]; label: string }> = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
];

/** Parses `#/usage?tab=&range=`; unknown values fall back to defaults. */
export function parseUsageHash(hash: string): { tab: UsageTab; range: string } {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = h.startsWith("/usage?") ? h.slice("/usage?".length) : "";
  const params = new URLSearchParams(q);
  const tab = USAGE_TABS.includes(params.get("tab") as UsageTab) ? (params.get("tab") as UsageTab) : "overview";
  const range = USAGE_RANGE_TABS.some((r) => r.value === params.get("range")) ? params.get("range")! : "24h";
  return { tab, range };
}

/** Writes tab+range into the hash (no history spam: replaceState). */
export function usageHashFor(tab: UsageTab, range: string): string {
  return `#/usage?tab=${tab}&range=${range}`;
}

/** Compact token counts: 1221 → "1.2k", 3_400_000 → "3.4M". */
export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Durations: 340 → "340 ms", 1500 → "1.5 s", 65_000 → "1m 5s". */
export function fmtDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function fmtTps(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v.toFixed(1)} tok/s`;
}

export function fmtPct(frac: number | null | undefined): string {
  return frac === null || frac === undefined || !Number.isFinite(frac) ? "—" : `${(frac * 100).toFixed(1)}%`;
}

export function fmtCount(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : String(n);
}

/** Short UTC time for bucket labels: "10-20 09:00" (epoch ms input). */
export function fmtBucketShort(t: number): string {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:00`;
}

export function fmtTimeIso(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export type UsageStatusTier = "ok" | "warn" | "error";

/** Chip tier for a request row: error beats warn beats ok. */
export function requestTier(row: Pick<UsageRequestRow, "status" | "error">): UsageStatusTier {
  if (row.error !== null || (row.status !== null && row.status >= 400)) return "error";
  if (row.status === null) return "warn";
  return "ok";
}

export function tierChipClass(tier: UsageStatusTier): string {
  return tier === "error" ? "chip--warn" : tier === "warn" ? "chip--muted" : "chip--ok";
}

/** Status cell text: HTTP status, finish reason, or error marker. */
export function statusText(row: Pick<UsageRequestRow, "status" | "finishReason" | "error">): string {
  if (row.error !== null) return row.status !== null ? `${row.status}` : "ERR";
  if (row.status !== null && row.status >= 400) return String(row.status);
  return row.finishReason ?? (row.status !== null ? String(row.status) : "—");
}

/** Chart geometry for one usage series (shared domain, floor at zero). */
export function usageChart(
  points: Array<{ t: string; value: number | null }>,
  width: number,
  height: number,
  opts: { color?: string; floorZero?: boolean } = {},
): LensChart {
  const values = points.map((p) => (typeof p.value === "number" && Number.isFinite(p.value) ? p.value : null));
  const finite = values.filter((v): v is number => v !== null);
  let yMin = finite.length > 0 ? Math.min(...finite) : 0;
  let yMax = finite.length > 0 ? Math.max(...finite) : 1;
  if (opts.floorZero !== false) yMin = Math.min(0, yMin);
  if (yMin === yMax) {
    yMin -= 0.5;
    yMax += 0.5;
  }
  const color = opts.color ?? "var(--thread)";
  return {
    paths: [{ d: sparklinePath(values, width, height, { min: yMin, max: yMax }), color, dashed: false }],
    series: [{ label: "", color, points: values }],
    times: points.map((p) => new Date(p.t).getTime()),
    guides: [],
    markers: [],
    yMin,
    yMax,
    width,
    height,
  };
}

/** Folds overview series into the two activity chart inputs. */
export function activityCharts(
  series: UsageOverviewResponse["series"],
  width: number,
  height: number,
): { requests: LensChart; errors: LensChart; tokens: LensChart } {
  return {
    requests: usageChart(series.map((p) => ({ t: p.t, value: p.requests })), width, height),
    errors: usageChart(series.map((p) => ({ t: p.t, value: p.errors })), width, height),
    tokens: usageChart(
      series.map((p) => ({ t: p.t, value: p.totalTokens })),
      width,
      height,
    ),
  };
}

export interface TokenMixRow {
  model: string;
  share: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  requests: number;
  errors: number;
}

/** Token mix rows with a computed share of the total. */
export function tokenMix(mix: UsageOverviewResponse["tokenMix"]): TokenMixRow[] {
  const total = mix.reduce((s, r) => s + r.totalTokens, 0);
  return mix.map((r) => ({
    model: r.model,
    share: total > 0 ? r.totalTokens / total : null,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    cachedTokens: r.cachedTokens,
    reasoningTokens: r.reasoningTokens,
    totalTokens: r.totalTokens,
    requests: r.requests,
    errors: r.errors,
  }));
}

/** Merges a live SSE usage frame into a requests page (newest first). */
export function mergeLiveRequest(rows: UsageRequestRow[], event: UsageEvent, cap: number): UsageRequestRow[] {
  const merged = [{ ...event.request, nodeId: event.nodeId, receivedAtMs: event.serverTimeMs }, ...rows];
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

/** Error groups sorted newest-last-seen first, count desc (server pre-sorts). */
export function errorGroupRows(groups: UsageErrorsResponse["groups"]): UsageErrorsResponse["groups"] {
  return [...groups].sort((a, b) => b.count - a.count || b.lastSeenMs - a.lastSeenMs);
}

/** Top models for the Models tab selector (by total tokens, "" last). */
export function topModels(models: UsageModelsResponse["models"], limit: number): string[] {
  return models
    .filter((m) => m.model.length > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit)
    .map((m) => m.model);
}

/** Series points for one model (usage buckets carry the same grid). */
export function modelSeries(series: UsageModelsResponse["series"], model: string): UsageModelsResponse["series"][number]["points"] {
  return series.find((s) => s.model === model)?.points ?? [];
}

/** Requests response → table rows (already newest first from the API). */
export function requestRows(res: UsageRequestsResponse): UsageRequestRow[] {
  return res.rows;
}
