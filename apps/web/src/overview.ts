import { DEFAULT_BASE_OVERHEAD_W, GB10_SYSTEM_ENVELOPE_W, type AnalyticsPoint, type AnalyticsSeries, type HardwareSnapshot, type LlmPortSnapshot, type SseEvent } from "@irori/core";
import { jobLabel } from "./jobs";
import type { LlmHistoryPoint } from "./api";
import { fmtBucket, lensChart, type LensChart } from "./analytics";

/**
 * Pure view models for the Overview landing page (IRI-013) — DOM-free like
 * card-data/llm-data so it is unit-testable in the node env.
 */

// ─── head hero ──────────────────────────────────────────────────────────────

export interface HeroData {
  port: number;
  backend: string;
  model: string | null;
  decodeTps: number | null;
  prefillTps: number | null;
  queueRunning: number | null;
  queueWaiting: number | null;
  kvCachePct: number | null;
  ttftP95Ms: number | null;
  e2eP95Ms: number | null;
  itlP95Ms: number | null;
  /** cached / prompt for the current probe pass; null when counters absent. */
  cacheHitPct: number | null;
}

/** Live per-node draw (IR-224 S6): GPU + CPU package + base overhead, clamped
 *  to the GB10 envelope — the same math as the server power analytics. Null
 *  when the snapshot reports nothing readable (gpu and cpu both 0/absent):
 *  the now-surfaces must never average stale range buckets. */
export function snapshotNodeWatts(snap: HardwareSnapshot): number | null {
  const gpu = (snap.gpus ?? []).reduce((a, g) => a + (g.powerW ?? 0), 0);
  const cpu = snap.cpu?.packagePowerW ?? 0;
  if (gpu === 0 && cpu === 0) return null;
  return Math.min(gpu + cpu + DEFAULT_BASE_OVERHEAD_W, GB10_SYSTEM_ENVELOPE_W);
}

/** The port the hero speaks about: serving ports first, busiest decode wins;
 *  falls back to the first detected, then the first port at all. */
export function pickPrimaryPort(ports: LlmPortSnapshot[] | null | undefined): LlmPortSnapshot | null {
  if (ports === null || ports === undefined || ports.length === 0) return null;
  const serving = ports.filter((p) => p.detected && p.decodeTps !== null);
  const pool = serving.length > 0 ? serving : ports.filter((p) => p.detected);
  const ranked = (pool.length > 0 ? pool : ports).slice().sort((a, b) => (b.decodeTps ?? -1) - (a.decodeTps ?? -1));
  return ranked[0] ?? null;
}

/** Hero stats for a single port snapshot (per-serving-process cards). */
export function heroDataForPort(p: LlmPortSnapshot): HeroData {
  const tokens = p.tokens ?? null;
  const cacheHitPct =
    tokens !== null && tokens.prompt !== null && tokens.prompt > 0 && tokens.cached !== null
      ? (tokens.cached / tokens.prompt) * 100
      : null;
  return {
    port: p.port,
    backend: p.backend,
    model: p.model,
    decodeTps: p.decodeTps,
    prefillTps: p.prefillTps,
    queueRunning: p.queueRunning,
    queueWaiting: p.queueWaiting,
    kvCachePct: p.kvCachePct,
    ttftP95Ms: p.ttftP95Ms,
    e2eP95Ms: p.e2eP95Ms,
    itlP95Ms: p.itlP95Ms,
    cacheHitPct,
  };
}

/** Highest decode tok/s in the window (the hero's "peak" sub-label). */
export function peakDecode(points: LlmHistoryPoint[]): number | null {
  const values = points.map((p) => p.decodeTps).filter((v): v is number => v !== null);
  return values.length === 0 ? null : Math.max(...values);
}

/** IR-235: the hero peak sub-label names the bucket granularity the peak was
 *  computed over — an hour-bucket "peak" is a bucket average, never the
 *  instant hero value, so a bare "peak N" reads as a contradiction. */
export function peakSubLabel(granularity: string, peak: number): string {
  const word = granularity === "minute" ? "minute" : granularity === "day" ? "day" : "hour";
  return `peak ${word} ${Math.round(peak)}`;
}

/** AnalyticsPoint with every lens key nulled except the given patch — the
 *  hero chart reuses lensChart geometry over llm-history buckets. */
function heroPoint(t: number, patch: Partial<AnalyticsPoint>): AnalyticsPoint {
  return {
    t,
    coverage: null,
    usedBytes: null,
    totalBytes: null,
    gpuUsedBytes: null,
    decodeTps: null,
    prefillTps: null,
    watts: null,
    gpuW: null,
    cpuW: null,
    baseW: null,
    gpuMin: null,
    gpuMax: null,
    gpuAvg: null,
    cpuMin: null,
    cpuMax: null,
    cpuAvg: null,
    throttled: null,
    generated: null,
    prompt: null,
    cached: null,
    ...patch,
  };
}

/** Decode+prefill chart for one port's history over `label` (per-series
 *  scales, two lines — a quiet prefill stays legible next to spiky decode). */
export function heroSpark(points: LlmHistoryPoint[], label: string, width = 600, height = 130): LensChart {
  return lensChart(
    [
      { key: "decode", label: `decode ${label}`, points: points.map((p) => heroPoint(p.t, { decodeTps: p.decodeTps })) },
      { key: "prefill", label: `prefill ${label}`, points: points.map((p) => heroPoint(p.t, { prefillTps: p.prefillTps })) },
    ],
    "decodeTps",
    width,
    height,
    { valueKeys: ["decodeTps", "prefillTps"], floorZero: true, perSeriesScale: true },
  );
}

// ─── power card ─────────────────────────────────────────────────────────────

export interface PowerNode {
  key: string;
  label: string;
  watts: number | null;
  coverage: number | null;
}

export interface PowerData {
  nodes: PowerNode[];
  /** Sum of the per-node latest estimates; null when nothing is readable. */
  fleetNow: number | null;
  /** Mean of the latest per-node coverages; null when none report. */
  coverage: number | null;
}

/** Latest readable watts per node series (scans back over null buckets). */
export function computePower(series: AnalyticsSeries[]): PowerData {
  const nodes: PowerNode[] = series.map((s) => {
    for (let i = s.points.length - 1; i >= 0; i--) {
      const p = s.points[i]!;
      if (p.watts !== null) return { key: s.key, label: s.label, watts: p.watts, coverage: p.coverage };
    }
    return { key: s.key, label: s.label, watts: null, coverage: null };
  });
  const watts = nodes.map((n) => n.watts).filter((w): w is number => w !== null);
  const coverages = nodes.map((n) => n.coverage).filter((c): c is number => c !== null);
  return {
    nodes,
    fleetNow: watts.length === 0 ? null : watts.reduce((a, b) => a + b, 0),
    coverage: coverages.length === 0 ? null : coverages.reduce((a, b) => a + b, 0) / coverages.length,
  };
}

// ─── range filter + fleet aggregation (IRI-025) ────────────────────────────

/** Overview chart range filter: wire values valid for BOTH the history and
 *  the analytics APIs; week/month label the existing 7d/30d. */
export const OVERVIEW_RANGES = [
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "week" },
  { value: "30d", label: "month" },
] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number]["value"];

/** Bucket duration for an analytics granularity. */
export function granularityMs(g: "minute" | "hour" | "day"): number {
  return g === "minute" ? 60_000 : g === "hour" ? 3_600_000 : 86_400_000;
}

export interface FleetPowerPoint { t: number; w: number | null }

/** Sums the spark nodes' watts per bucket (the NAS has no power telemetry). */
export function fleetPowerSeries(series: AnalyticsSeries[], sparkIds: Set<string>): FleetPowerPoint[] {
  const times = new Set<number>();
  for (const s of series) {
    if (!sparkIds.has(s.key)) continue;
    for (const p of s.points) times.add(p.t);
  }
  const out: FleetPowerPoint[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    let w: number | null = null;
    for (const s of series) {
      if (!sparkIds.has(s.key)) continue;
      const p = s.points.find((x) => x.t === t);
      if (p !== undefined && typeof p.watts === "number") w = (w ?? 0) + p.watts;
    }
    out.push({ t, w });
  }
  return out;
}

/** kWh over the window: Σ(watts × bucket duration). */
export function fleetEnergyKwh(points: FleetPowerPoint[], bucketMs: number): number | null {
  let wh = 0;
  let any = false;
  for (const p of points) {
    if (p.w === null) continue;
    any = true;
    wh += (p.w * bucketMs) / 3_600_000;
  }
  return any ? wh / 1000 : null;
}

export interface PowerBar { t: number; endT: number; w: number; wh: number; pct: number }

/** Bins the fleet series into ≤ `target` bars (null buckets skipped). `bucketMs`
 *  is the analytics bucket duration behind each point: per-bar energy (Wh) and
 *  the covered span [t, endT) derive from it (IR-97). */
export function binFleetPower(points: FleetPowerPoint[], bucketMs: number, target = 36): { bars: PowerBar[]; avgW: number | null } {
  const filled = points.filter((p): p is FleetPowerPoint & { w: number } => p.w !== null);
  if (filled.length === 0) return { bars: [], avgW: null };
  const group = Math.max(1, Math.ceil(filled.length / target));
  const bars: PowerBar[] = [];
  for (let i = 0; i < filled.length; i += group) {
    const slice = filled.slice(i, i + group);
    const w = slice.reduce((a, b) => a + b.w, 0) / slice.length;
    const wh = slice.reduce((a, b) => a + (b.w * bucketMs) / 3_600_000, 0);
    bars.push({ t: slice[0]!.t, endT: slice[slice.length - 1]!.t + bucketMs, w, wh, pct: Math.min(100, (w / GB10_SYSTEM_ENVELOPE_W) * 100) });
  }
  const avgW = filled.reduce((a, b) => a + b.w, 0) / filled.length;
  return { bars, avgW };
}

/** Energy label: "3.1 Wh" below a kWh, "1.49 kWh" style above (matches the ENERGY stat). */
export function fmtEnergy(wh: number): string {
  if (wh >= 1000) return `${(wh / 1000).toFixed(2)} kWh`;
  if (wh >= 10) return `${Math.round(wh)} Wh`;
  return `${Math.round(wh * 10) / 10} Wh`;
}

/** Hover slot label for a power bar: "14:32 – 14:33" (minute bins),
 *  "Oct 20 14:00 – 15:00" (hour), "Oct 20" or "Oct 20 – Oct 22" (day). */
export function powerBarSlot(bar: PowerBar, granularity: "minute" | "hour" | "day"): string {
  const start = fmtBucket(bar.t, granularity);
  if (granularity === "minute") return `${start} – ${fmtBucket(bar.endT, "minute")}`;
  if (granularity === "hour") {
    const end = new Date(bar.endT);
    const endHM = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    return `${start} – ${endHM}`;
  }
  const endDay = fmtBucket(bar.endT - 1, "day"); // inclusive last covered day
  return endDay === start ? start : `${start} – ${endDay}`;
}

export interface TokenTotals { input: number; cached: number; generated: number }

/** Sums the spark nodes' token ledger points over the window. */
export function tokenTotals(series: AnalyticsSeries[], sparkIds: Set<string>): TokenTotals {
  let input = 0;
  let cached = 0;
  let generated = 0;
  for (const s of series) {
    if (!sparkIds.has(s.key)) continue;
    for (const p of s.points) {
      input += p.prompt ?? 0;
      cached += p.cached ?? 0;
      generated += p.generated ?? 0;
    }
  }
  return { input, cached, generated };
}

// ─── NAS store card ─────────────────────────────────────────────────────────

export interface NasData {
  /** null when the models fetch failed — render "—" rather than 0. */
  modelCount: number | null;
  newestAddedAt: string | null;
  storeUsedBytes: number | null;
  storeTotalBytes: number | null;
  storePct: number | null;
}

export function computeNasData(
  modelsTotal: number | null,
  newestAddedAt: string | null,
  snapshot: HardwareSnapshot | null | undefined,
): NasData {
  let storeUsedBytes: number | null = null;
  let storeTotalBytes: number | null = null;
  for (const s of snapshot?.storage ?? []) {
    if (s.totalBytes <= 0) continue;
    if (storeTotalBytes === null || s.totalBytes > storeTotalBytes) {
      storeTotalBytes = s.totalBytes;
      storeUsedBytes = s.usedBytes;
    }
  }
  return {
    modelCount: modelsTotal,
    newestAddedAt,
    storeUsedBytes,
    storeTotalBytes,
    storePct: storeUsedBytes !== null && storeTotalBytes !== null && storeTotalBytes > 0 ? (storeUsedBytes / storeTotalBytes) * 100 : null,
  };
}

/** "5m ago" / "2h ago" / "3d ago"; null input → null. */
export function relativeTime(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── fleet temperatures (IR-129) ────────────────────────────────────────────

/** Warn/crit thresholds (°C) for the fleet-temperature surfaces. */
export const TEMP_WARN_C = 70;
export const TEMP_CRIT_C = 90;

export interface FleetTempItem {
  id: string;
  name: string;
  /** Hottest GPU package temp; null when the node reports no sensor. */
  gpu: number | null;
  /** CPU package temp; null when the node reports no sensor. */
  cpu: number | null;
  /** Ordering key: max(gpu, cpu); offline nodes sink via -2, sensor-less via -1. */
  max: number;
  online: boolean;
}

/** Which sensor produced the hottest reading — `both` when GPU and CPU tie (IR-287). */
export type HottestSource = "gpu" | "cpu" | "both";

export interface FleetTemps {
  /** Hottest first (offline nodes last). */
  items: FleetTempItem[];
  /** The hottest readable node — the page-head token; null when nothing reads. */
  hottest: { name: string; tempC: number; source: HottestSource } | null;
}

/** Page-head label for the hottest reading's sensor (IR-287). */
export function hottestSourceLabel(source: HottestSource): string {
  return source === "both" ? "GPU/CPU" : source.toUpperCase();
}

/** Fleet thermal snapshot over the given nodes (callers pass spark nodes
 *  only — the NAS has no power/thermal telemetry). An offline node is a
 *  `— OFFLINE` item; an online node without sensors reports `—` per axis. */
export function fleetTemps(
  nodes: Array<{ id: string; name: string; online: boolean; snapshot: HardwareSnapshot | null | undefined }>,
): FleetTemps {
  const items: FleetTempItem[] = nodes.map((n) => {
    if (!n.online) return { id: n.id, name: n.name, gpu: null, cpu: null, max: -2, online: false };
    const gpuReadings = (n.snapshot?.gpus ?? []).map((g) => g.tempC).filter((t): t is number => t !== null);
    const gpu = gpuReadings.length > 0 ? Math.max(...gpuReadings) : null;
    const cpu = typeof n.snapshot?.cpu?.tempC === "number" ? (n.snapshot.cpu.tempC as number) : null;
    const max = gpu === null && cpu === null ? -1 : Math.max(gpu ?? -1, cpu ?? -1);
    return { id: n.id, name: n.name, gpu, cpu, max, online: true };
  });
  items.sort((a, b) => b.max - a.max);
  const hottest = items.find((i) => i.max >= 0);
  if (hottest === undefined) return { items, hottest: null };
  // max came from whichever axis equals it; an exact GPU = CPU tie names both.
  const source: HottestSource =
    hottest.gpu !== null && hottest.gpu === hottest.cpu ? "both" : hottest.gpu === hottest.max ? "gpu" : "cpu";
  return { items, hottest: { name: hottest.name, tempC: hottest.max, source } };
}

// ─── telemetry feed ─────────────────────────────────────────────────────────

export interface FeedLine {
  /** Server receive time of the event. */
  t: number;
  text: string;
}

function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** IR-248: product-report jobs (models-inventory, hygiene-*, staging-tree-audit,
 *  quarantine-prune, nas-delete-batch, …) stream their whole JSON payload as
 *  ONE final line — the feed renders a short summary instead (the job sheet
 *  keeps the raw output). Anything long or JSON-shaped is treated as payload. */
export function feedLineText(kind: string | undefined, line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) return line;
  if (trimmed.length > 400) {
    return `${kind ?? "job"}: report written${trimmed.length >= 1024 ? ` · ${(trimmed.length / 1024).toFixed(1)} KB` : ""}`;
  }
  // Short but brace-shaped: only a real JSON document counts as payload.
  if (!/^\s*[[{]/.test(line)) return line;
  try {
    JSON.parse(trimmed);
  } catch {
    return line;
  }
  return `${kind ?? "job"}: report written`;
}

function pct(n: number | null | undefined): string {
  return typeof n === "number" ? ` · ${Math.round(n)}%` : "";
}

/** Maps feed frames to display lines, newest last, capped. One feed for all
 *  event classes (owner decision, mockup round 5). */
export function feedLines(
  events: SseEvent[],
  nodeName: (id: string) => string,
  cap = 30,
  /** IR-102: job context (node id + kind + params) for job-progress labels. */
  jobById?: (jobId: string) => { nodeId: string; kind: string; params?: Record<string, unknown> } | undefined,
  /** IR-244: queue-row errors for failed download-queue terminal lines. */
  downloadError?: (name: string) => string | null,
): FeedLine[] {
  const lines: FeedLine[] = [];
  for (const event of events) {
    const node = "nodeId" in event && typeof event.nodeId === "string" ? nodeName(event.nodeId) : "node";
    switch (event.type) {
      case "job": {
        let text = `${node} · ${event.kind}${jobLabel(event.params)} ${event.status === "running" ? "started" : event.status}${event.durationMs !== null ? ` · ${fmtDuration(event.durationMs)}` : ""}`;
        // IR-244: a failed batch's reason lives in the queue rows (the
        // job-progress frames that carried it are transient, cap 120).
        if (event.kind === "download-queue" && event.status === "failed" && downloadError !== undefined) {
          const params = (event as { params?: { downloads?: Array<{ name?: unknown }> } }).params;
          const names = Array.isArray(params?.downloads)
            ? params!.downloads!.map((d) => (typeof d?.name === "string" ? d.name : null)).filter((n): n is string => n !== null)
            : [];
          const err = names.map((n) => downloadError(n)).find((e) => typeof e === "string" && e.length > 0) ?? null;
          if (err !== null) text += ` · ${err}`;
        }
        lines.push({ t: event.serverTimeMs, text });
        break;
      }
      case "job-progress": {
        // IR-102: the job's live output streams into the feed; the context
        // gives node and kind, falling back to the frame's node id.
        const job = jobById?.(event.jobId);
        const label = job !== undefined ? `${nodeName(job.nodeId)} · ${job.kind}${jobLabel(job.params)}: ` : `${node} · `;
        // IR-248: a full JSON payload line renders as a one-line summary.
        lines.push({ t: event.serverTimeMs, text: `${label}${feedLineText(job?.kind, event.line)}` });
        break;
      }
      case "thermal":
        lines.push({
          t: event.serverTimeMs,
          text: `${node} · GPU${event.gpuIndex} ${event.active.length > 0 ? `throttle: ${event.active.join(", ")}` : "throttle cleared"}`,
        });
        break;
      case "bench":
        lines.push({
          t: event.serverTimeMs,
          text: `${node} · ${event.bench} bench ${event.status}${event.progress?.label !== undefined && event.progress.label !== "" ? ` · ${event.progress.label}` : ""}${event.progress?.liveTps != null ? ` · ${Math.round(event.progress.liveTps)} tok/s` : ""}`,
        });
        break;
      case "node-online":
      case "node-offline":
        lines.push({ t: event.serverTimeMs, text: `${node} · ${event.type === "node-online" ? "online" : "offline"}` });
        break;
      case "setup-state":
        lines.push({ t: event.serverTimeMs, text: `setup · ${event.status}${event.health !== null ? ` · ${event.health}` : ""}${event.lastError !== null ? ` · ${event.lastError}` : ""}` });
        break;
      case "setup-log":
        // IR-124: the engine's own output streams into the feed while the
        // weights load — node and setup name prefix the line.
        lines.push({ t: event.serverTimeMs, text: `${node} · ${event.name}: ${event.line}` });
        break;
      case "setup-transfer":
        lines.push({
          t: event.serverTimeMs,
          text: `transfer · ${event.label} ${event.status}${event.progress?.percent != null ? pct(event.progress.percent) : ""}`,
        });
        break;
      case "network-test":
        // IRI-166: the hub's summary already names both nodes.
        lines.push({ t: event.serverTimeMs, text: event.summary });
        break;
      default:
        break; // snapshot/llm/heartbeat never render
    }
  }
  return lines.slice(Math.max(0, lines.length - cap));
}
