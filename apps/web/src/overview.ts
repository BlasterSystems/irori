import type { AnalyticsPoint, AnalyticsSeries, HardwareSnapshot, LlmPortSnapshot, SseEvent } from "@irori/core";
import type { LlmHistoryPoint } from "./api";
import { lensChart, type LensChart } from "./analytics";

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

/** The port the hero speaks about: serving ports first, busiest decode wins;
 *  falls back to the first detected, then the first port at all. */
export function pickPrimaryPort(ports: LlmPortSnapshot[] | null | undefined): LlmPortSnapshot | null {
  if (ports === null || ports === undefined || ports.length === 0) return null;
  const serving = ports.filter((p) => p.detected && p.decodeTps !== null);
  const pool = serving.length > 0 ? serving : ports.filter((p) => p.detected);
  const ranked = (pool.length > 0 ? pool : ports).slice().sort((a, b) => (b.decodeTps ?? -1) - (a.decodeTps ?? -1));
  return ranked[0] ?? null;
}

export function computeHeroData(ports: LlmPortSnapshot[] | null | undefined): HeroData | null {
  const p = pickPrimaryPort(ports);
  if (p === null) return null;
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

/** 24h decode+prefill chart for one port's history (shared domain, two lines). */
export function heroSpark(points: LlmHistoryPoint[], width = 600, height = 36): LensChart {
  return lensChart(
    [
      { key: "decode", label: "decode 24h", points: points.map((p) => heroPoint(p.t, { decodeTps: p.decodeTps })) },
      { key: "prefill", label: "prefill 24h", points: points.map((p) => heroPoint(p.t, { prefillTps: p.prefillTps })) },
    ],
    "decodeTps",
    width,
    height,
    { valueKeys: ["decodeTps", "prefillTps"], floorZero: true },
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

function pct(n: number | null | undefined): string {
  return typeof n === "number" ? ` · ${Math.round(n)}%` : "";
}

/** Maps feed frames to display lines, newest last, capped. One feed for all
 *  event classes (owner decision, mockup round 5). */
export function feedLines(events: SseEvent[], nodeName: (id: string) => string, cap = 30): FeedLine[] {
  const lines: FeedLine[] = [];
  for (const event of events) {
    const node = "nodeId" in event && typeof event.nodeId === "string" ? nodeName(event.nodeId) : "node";
    switch (event.type) {
      case "job":
        lines.push({ t: event.serverTimeMs, text: `${node} · ${event.kind} ${event.status}${event.durationMs !== null ? ` · ${fmtDuration(event.durationMs)}` : ""}` });
        break;
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
      case "setup-transfer":
        lines.push({
          t: event.serverTimeMs,
          text: `transfer · ${event.label} ${event.status}${event.progress?.percent != null ? pct(event.progress.percent) : ""}`,
        });
        break;
      default:
        break; // snapshot/llm/heartbeat never render
    }
  }
  return lines.slice(Math.max(0, lines.length - cap));
}
