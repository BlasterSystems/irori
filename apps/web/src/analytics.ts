import type { AnalyticsPoint, AnalyticsResponse, AnalyticsSeries } from "@irori/core";

export type { AnalyticsPoint };
import { sparklinePath } from "./sparkline";
import type { SparklineDomain, SparklineScale } from "./sparkline";

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
/** IRI-075: setup grouping is tokens-lens-only (per Serve setup). */
export const TOKEN_GROUP_TABS = [...GROUP_TABS, { key: "setup", label: "Setup" }] as const;

/** Warn tier for temperatures app-wide (cards, node detail, analytics lens). */

export interface ChartSeries {
  label: string;
  color: string;
  dashed?: boolean;
  /** Own value domain when the chart scales series independently (perSeriesScale). */
  scale?: SparklineScale;
  points: Array<number | null>;
}

export interface LensChart {
  paths: Array<{ d: string; color: string; dashed: boolean }>;
  /** Hover sources: label/color per series with per-bucket values (nulls = gaps). */
  series: ChartSeries[];
  /** Bucket start (epoch ms) per index — from the longest series grid. */
  times: number[];
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
  /** Per-series metric (parallel to `series`); defaults to `valueKey` for all.
   *  Lets one chart mix metrics over a shared domain (e.g. decode+prefill). */
  valueKeys?: Array<keyof AnalyticsPoint>;
  /** Scale each series to its own min/max instead of one shared domain — keeps
   *  a quiet line legible next to a spiky one (hero decode+prefill, IR-110).
   *  domain/ceiling/floor/guides are chart-level and unsupported with this on. */
  perSeriesScale?: boolean;
}

/** Per-series domain (IR-110): own min/max, 0-floored when `floorZero`. An
 *  all-zero series pins to `{min: 0, max: 1}` so a flat zero line renders at
 *  the bottom (the shared-domain look); other constants get the ±0.5 slack at
 *  their value. null when no point is readable. */
function seriesScale(points: Array<number | null>, floorZero: boolean): SparklineScale | null {
  const finite = points.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  if (finite.length === 0) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) {
    return floorZero && min === 0 ? { min: 0, max: 1 } : { min: min - 0.5, max: max + 0.5 };
  }
  return { min: floorZero ? Math.min(0, min) : min, max };
}

/** Chart geometry for lens views: one shared domain, or per-series with `perSeriesScale`. */
export function lensChart(
  series: AnalyticsSeries[],
  valueKey: keyof AnalyticsPoint,
  width: number,
  height: number,
  opts: LensChartOptions = {},
): LensChart {
  const charts: ChartSeries[] = series.map((s, i) => {
    const key = opts.valueKeys?.[i] ?? valueKey;
    return {
      label: s.label,
      color: colorFor(i),
      points: s.points.map((p) => (typeof p[key] === "number" ? (p[key] as number) : null)),
    };
  });
  // IR-110: per-series domains — each series scales to its own 0-floored
  // min/max so a quiet line stays legible next to a spiky one. The chart-level
  // domain becomes the union of the per-series scales.
  const scales: Array<SparklineScale | null> =
    opts.perSeriesScale === true
      ? charts.map((c) => seriesScale(c.points, opts.floorZero === true))
      : charts.map(() => null);
  charts.forEach((c, i) => {
    if (scales[i] !== null) c.scale = scales[i]!;
  });
  const applied = scales.filter((s): s is SparklineScale => s !== null);
  const finite = charts.flatMap((c) => c.points).filter((v): v is number => v !== null && Number.isFinite(v));
  let yMin: number;
  let yMax: number;
  if (opts.perSeriesScale === true) {
    yMin = applied.length > 0 ? Math.min(...applied.map((s) => s.min)) : 0;
    yMax = applied.length > 0 ? Math.max(...applied.map((s) => s.max)) : 1;
  } else {
    yMin = finite.length > 0 ? Math.min(...finite) : 0;
    yMax = finite.length > 0 ? Math.max(...finite) : 1;
    if (opts.domain?.min !== undefined) yMin = Math.min(opts.domain.min, yMin);
    if (opts.domain?.max !== undefined) yMax = Math.max(opts.domain.max, yMax);
    if (opts.floorZero === true) yMin = Math.min(0, yMin);
    if (opts.floor !== undefined) yMin = Math.min(opts.floor, yMin);
    if (opts.ceiling !== undefined) yMax = Math.max(opts.ceiling, yMax);
    if (yMin === yMax) {
      yMin -= 0.5;
      yMax += 0.5;
    }
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
    .map((c, i) => ({
      d: sparklinePath(c.points, width, height, { min: yMin, max: yMax }, scales[i] ?? undefined),
      color: c.color,
      dashed: c.dashed === true,
    }))
    .filter((p) => p.d !== "");

  // All series share the server's bucket grid; the longest one is canonical.
  const times = series.reduce<number[]>(
    (best, s) => (s.points.length > best.length ? s.points.map((p) => p.t) : best),
    [],
  );

  return { paths, series: charts, times, guides, markers, yMin, yMax, width, height };
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

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Bucket-start label for chart hover tooltips: "14:05" (minute buckets),
 *  "Oct 20 14:00" (hour), "Oct 20" (day). Local time, en-US abbreviations. */
export function fmtBucket(t: number, granularity: "minute" | "hour" | "day"): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const day = `${MONTHS_SHORT[d.getMonth()]!} ${d.getDate()}`;
  if (granularity === "minute") return `${hh}:${mm}`;
  if (granularity === "hour") return `${day} ${hh}:00`;
  return day;
}

/** Disk usage percent at which the value renders warn (owner rule: > 80 %). */
