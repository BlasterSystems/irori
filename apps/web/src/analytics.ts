import type { AnalyticsPoint, AnalyticsResponse, AnalyticsSeries } from "@irori/core";

export type { AnalyticsPoint };
import { sparklinePath } from "./sparkline";
import type { SparklineDomain } from "./sparkline";

/**
 * Pure view-model shaping for the Analytics section (M7): per-lens series
 * extraction, chart geometry shared by all lenses, and formatters. DOM-free
 * like card-data/llm-data so it is unit-testable in the node env.
 */

export const LENS_TABS = [
  { lens: "memory", label: "Memory" },
  { lens: "decode", label: "Decode" },
  { lens: "power", label: "Power" },
  { lens: "temps", label: "Temps" },
  { lens: "tokens", label: "Tokens" },
] as const;

export const RANGE_TABS = ["1h", "24h", "7d", "30d", "90d"] as const;
export const GROUP_TABS = [
  { key: "cluster", label: "Cluster" },
  { key: "node", label: "Node" },
] as const;

export const TEMPS_WARN_C = 85;
export const TEMPS_CRITICAL_C = 90;

export interface ChartSeries {
  label: string;
  color: string;
  dashed?: boolean;
  points: Array<number | null>;
}

export interface LensChart {
  paths: Array<{ d: string; color: string; dashed: boolean }>;
  /** Horizontal guide lines (y in viewBox coords) with their value. */
  guides: Array<{ y: number; value: number }>;
  /** Throttle/crossing markers: x position + tier. */
  markers: Array<{ x: number; tier: "warn" | "critical" }>;
  yMin: number;
  yMax: number;
  width: number;
  height: number;
}

const COLORS = ["var(--thread)", "var(--ink-2)", "var(--ink-3)", "var(--ok)", "var(--warn)"];

function colorFor(index: number): string {
  return COLORS[index % COLORS.length]!;
}

export interface LensChartOptions {
  domain?: SparklineDomain;
  /** Floor the domain at zero (counts, bytes, rates). */
  floorZero?: boolean;
  /** Hard ceiling (e.g. the GB10 envelope for power). */
  ceiling?: number;
  /** Horizontal guide values (temps 85/90). */
  guides?: number[];
  /** Crossing markers: points where the key ≥ warn render warn, ≥ critical critical. */
  markers?: { key: keyof AnalyticsPoint; warn: number; critical: number };
  /** Extra floor (temps never chart below ~30 °C). */
  floor?: number;
}

/** Shared-domain chart geometry for one lens view. */
export function lensChart(
  series: AnalyticsSeries[],
  valueKey: keyof AnalyticsPoint,
  width: number,
  height: number,
  opts: LensChartOptions = {},
): LensChart {
  const charts: ChartSeries[] = series.map((s, i) => ({
    label: s.label,
    color: colorFor(i),
    points: s.points.map((p) => (typeof p[valueKey] === "number" ? (p[valueKey] as number) : null)),
  }));
  const finite = charts.flatMap((c) => c.points).filter((v): v is number => v !== null && Number.isFinite(v));
  let yMin = finite.length > 0 ? Math.min(...finite) : 0;
  let yMax = finite.length > 0 ? Math.max(...finite) : 1;
  if (opts.domain?.min !== undefined) yMin = Math.min(opts.domain.min, yMin);
  if (opts.domain?.max !== undefined) yMax = Math.max(opts.domain.max, yMax);
  if (opts.floorZero === true) yMin = Math.min(0, yMin);
  if (opts.floor !== undefined) yMin = Math.min(opts.floor, yMin);
  if (opts.ceiling !== undefined) yMax = Math.max(opts.ceiling, yMax);
  if (yMin === yMax) {
    yMin -= 0.5;
    yMax += 0.5;
  }

  const y = (v: number): number => height - ((v - yMin) / (yMax - yMin)) * height;
  const n = Math.max(1, ...charts.map((c) => c.points.length));
  const x = (i: number): number => (n <= 1 ? width / 2 : (i / (n - 1)) * width);

  const guides: LensChart["guides"] = [];
  for (const value of opts.guides ?? []) {
    if (value >= yMin && value <= yMax) guides.push({ y: y(value), value });
  }

  const markers: LensChart["markers"] = [];
  const markerSpec = opts.markers;
  if (markerSpec !== undefined) {
    for (const s of series) {
      s.points.forEach((p, i) => {
        const v = p[markerSpec.key];
        if (typeof v !== "number") return;
        if (v >= markerSpec.critical) markers.push({ x: x(i), tier: "critical" });
        else if (v >= markerSpec.warn) markers.push({ x: x(i), tier: "warn" });
      });
    }
  }

  const paths = charts
    .map((c) => ({ d: sparklinePath(c.points, width, height, { min: yMin, max: yMax }), color: c.color, dashed: c.dashed === true }))
    .filter((p) => p.d !== "");

  return { paths, guides, markers, yMin, yMax, width, height };
}

export function seriesKeys(response: AnalyticsResponse): AnalyticsSeries[] {
  return response.series;
}

// ─── formatters ─────────────────────────────────────────────────────────────

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

export function fmtTps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v)} tok/s`;
}

export function fmtWatts(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v)} W`;
}

export function fmtTemp(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v)}°C`;
}

/** 0–100 disk usage percent, or null when unknown. */
export function diskPct(usedBytes: number | null | undefined, totalBytes: number | null | undefined): number | null {
  if (usedBytes === null || usedBytes === undefined || totalBytes === null || totalBytes === undefined) return null;
  if (totalBytes <= 0) return null;
  return Math.round((usedBytes / totalBytes) * 100);
}

/** Two-tier chip class (SPEC §11.6): plain ≤89, warn ≥90, none under 80. */
export function diskChipCls(pct: number | null): string | null {
  if (pct === null || pct < 80) return null;
  return pct >= 90 ? "chip--warn" : "chip";
}

export function sumReclaimable(audit: { categories: Array<{ reclaimableBytes: number }> } | null | undefined): number {
  if (audit === undefined || audit === null) return 0;
  return audit.categories.reduce((sum, c) => sum + c.reclaimableBytes, 0);
}
