import type { HardwareSnapshot } from "@irori/core";
import { formatGiB, formatMetricLine, formatPct } from "./card-data";
import type { HistoryRange, HistoryResponse } from "./api";

/* ── IRI-124: clock-cap presets ──────────────────────────────────────────── */

/** Owner-selected GPU SM ceilings; 3000 sits just under the GB10 maximum (3003 MHz). */
export const GPU_CLOCK_CAP_PRESETS = [1800, 2000, 2200, 3000] as const;
/**
 * CPU ceilings (owner decision 2026-11-04). A cap is a UNIFORM ceiling applied
 * to every cpufreq policy as `min(cap, cpuinfo_max_freq)`, so on GB10's two
 * clusters (2,808 and 3,900 MHz) every preset caps BOTH: 2800 → 2,800 / 2,800.
 * Only a cap above a cluster's own maximum leaves that cluster alone.
 */
export const CPU_CLOCK_CAP_PRESETS = [1400, 2000, 2800] as const;

export interface CapOption {
  value: string;
  label: string;
}

/**
 * `<select>` options for a clock cap: the presets, plus the stored value when
 * it is not one of them — a cap set by an older UI (or the API) must never
 * disappear from the control and read as "no cap".
 */
export function capOptions(
  presets: readonly number[],
  current: number | null | undefined,
): CapOption[] {
  const options: CapOption[] = presets.map((p) => ({ value: String(p), label: `${p} MHz` }));
  if (current !== null && current !== undefined && !presets.includes(current)) {
    options.push({ value: String(current), label: `${current} MHz (current)` });
  }
  return options;
}

/** Client-side fallback for the server's per-range bucket size (DB enum). */
export const RANGE_GRANULARITY: Record<HistoryRange, string> = {
  "30m": "minute",
  "1h": "minute",
  "4h": "minute",
  "24h": "hour",
  "7d": "hour",
  "30d": "hour",
  "90d": "day",
};

export function rangeToGranularity(range: HistoryRange): string {
  return RANGE_GRANULARITY[range];
}

/** Bytes/s → "184.4 MB/s" (SI units, as link rates are conventionally shown). */
export function formatRate(bps: number | null): string | null {
  if (bps === null) return null;
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"] as const;
  let value = bps;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  // A unit step happens at 1000, so value is always < 1000 here → one decimal.
  return `${value.toFixed(1)} ${units[unit]}`;
}

interface Band {
  min: number | null;
  avg: number | null;
  max: number | null;
}

/** "min 55°C · avg 62°C · max 71°C" — unreadable sides omitted. */
function formatBand(band: Band): string | null {
  const parts: string[] = [];
  if (band.min !== null) parts.push(`min ${Math.round(band.min)}°C`);
  if (band.avg !== null) parts.push(`avg ${Math.round(band.avg)}°C`);
  if (band.max !== null) parts.push(`max ${Math.round(band.max)}°C`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface DetailPanelData {
  /** Headline current value, "" when the series has no readable data. */
  current: string;
  /** Secondary line (band / power / tx), null when unreadable. */
  sub: string | null;
  /** Snapshot-fact lines (swap, unified pool, clocks). */
  notes: string[];
  series: Array<number | null>;
  /** Second series (network tx); null when the panel has a single line. */
  series2: Array<number | null> | null;
  /** IRI-124: bucket-average temperature for the CPU/GPU overlay; null elsewhere. */
  tempSeries: Array<number | null> | null;
}

export interface DetailData {
  hasHistory: boolean;
  granularity: string;
  pointCount: number;
  cpu: DetailPanelData;
  memory: DetailPanelData;
  gpu: DetailPanelData;
  network: DetailPanelData;
}

function emptyPanel(): DetailPanelData {
  return { current: "", sub: null, notes: [], series: [], series2: null, tempSeries: null };
}

function lastValue(series: Array<number | null>): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Last point whose `key` metric is readable; null when none is. */
function lastReadable<T>(points: T[], key: (p: T) => number | null): T | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p !== undefined && key(p) !== null) return p;
  }
  return null;
}

/**
 * Pure view model for NodeDetail: shapes a history response plus the live
 * snapshot into panel data so the component only renders fields. Absolutes
 * (total, swap, unified pool, clocks) come from the snapshot — history points
 * carry used bytes only — and are surfaced as notes/sub lines.
 */
export function computeDetailData(
  snapshot: HardwareSnapshot | null | undefined,
  history: HistoryResponse | null | undefined,
  range: HistoryRange,
): DetailData {
  const points = history?.points ?? [];
  const hasHistory = points.length > 0;

  const cpuSrc = lastReadable(points, (p) => p.cpu);
  // IRI-034: current CPU clock from the live snapshot, mirroring the GPU
  // `sm` note. Max across cores; the ` / max` half appears once agents
  // report perCoreMaxClocksKHz.
  const cpuNotes: string[] = [];
  if (hasHistory) {
    const clocks = snapshot?.cpu?.perCoreClocksKHz;
    if (clocks !== undefined && clocks.length > 0) {
      const maxClocks = snapshot?.cpu?.perCoreMaxClocksKHz;
      const maxPart =
        maxClocks !== undefined && maxClocks.length > 0
          ? ` / ${Math.round(Math.max(...maxClocks) / 1000).toLocaleString("en-US")}`
          : "";
      cpuNotes.push(`cpu ${Math.round(Math.max(...clocks) / 1000).toLocaleString("en-US")}${maxPart} MHz`);
    }
  }
  const cpu: DetailPanelData = {
    current: cpuSrc ? (formatPct(cpuSrc.cpu) ?? "") : "",
    sub: cpuSrc ? formatBand(cpuSrc.cpuTemp) : null,
    notes: cpuNotes,
    series: points.map((p) => p.cpu),
    series2: null,
    tempSeries: points.map((p) => p.cpuTemp.avg),
  };

  const memSrc = lastReadable(points, (p) => p.mem);
  const memory = snapshot?.memory ?? null;
  let memoryCurrent = "";
  if (memory) {
    const used = formatGiB(memory.usedBytes) ?? "?";
    const total = formatGiB(memory.totalBytes) ?? "?";
    memoryCurrent = `${used} / ${total} GB`;
  } else if (memSrc) {
    memoryCurrent = `${formatGiB(memSrc.mem) ?? "?"} GB`;
  }
  const memoryNotes: string[] = [];
  if (hasHistory) {
    const um = snapshot?.unifiedMemory;
    if (um) {
      let note = `unified memory · ${formatGiB(um.poolBytes) ?? "?"} GB pool · ${formatGiB(um.availableBytes) ?? "?"} GB available`;
      if (um.gpuReservedBytes !== null) {
        note += ` · ${formatGiB(um.gpuReservedBytes) ?? "?"} GB reserved`;
      }
      memoryNotes.push(note);
    }
  }

  const gpuSrc = lastReadable(points, (p) => p.gpu);
  const gpuSub = gpuSrc
    ? formatMetricLine(
        formatBand(gpuSrc.gpuTemp),
        gpuSrc.gpuPowerW !== null ? `${Math.round(gpuSrc.gpuPowerW)} W` : null,
      )
    : null;
  const gpuNotes: string[] = [];
  if (hasHistory) {
    const gpuMemSrc = lastReadable(points, (p) => p.gpuMem);
    if (gpuMemSrc) {
      gpuNotes.push(`gpu mem ${formatGiB(gpuMemSrc.gpuMem) ?? "?"} GB`);
    }
    const gpu = snapshot?.gpus[0];
    if (gpu?.smClockMHz != null) {
      const max =
        gpu.smClockMaxMHz != null
          ? ` / ${gpu.smClockMaxMHz.toLocaleString("en-US")}`
          : "";
      gpuNotes.push(`sm ${gpu.smClockMHz.toLocaleString("en-US")}${max} MHz`);
    }
  }

  const network: DetailPanelData = {
    current: formatRate(lastValue(points.map((p) => p.netRx))) ?? "",
    sub: formatRate(lastValue(points.map((p) => p.netTx))),
    notes: [],
    series: points.map((p) => p.netRx),
    series2: points.map((p) => p.netTx),
    tempSeries: null,
  };

  return {
    hasHistory,
    granularity: history?.granularity ?? rangeToGranularity(range),
    pointCount: points.length,
    cpu,
    memory: {
      current: hasHistory ? memoryCurrent : "",
      sub:
        memory && memory.swapTotalBytes !== null && hasHistory
          ? `swap ${formatGiB(memory.swapUsedBytes) ?? "?"} / ${formatGiB(memory.swapTotalBytes) ?? "?"} GB`
          : null,
      notes: memoryNotes,
      series: points.map((p) => p.mem),
      series2: null,
      tempSeries: null,
    },
    gpu: {
      current: gpuSrc ? (formatPct(gpuSrc.gpu) ?? "") : "",
      sub: hasHistory ? gpuSub : null,
      notes: gpuNotes,
      series: points.map((p) => p.gpu),
      series2: null,
      tempSeries: points.map((p) => p.gpuTemp.avg),
    },
    network: hasHistory
      ? network
      : { ...network, current: "", sub: null, series: [], series2: [], tempSeries: null },
  };
}
