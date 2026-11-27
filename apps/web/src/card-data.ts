import type { HardwareSnapshot, NodeInfo } from "@irori/core";
import { GB10_SOC_TDP_W, GB10_SYSTEM_ENVELOPE_W } from "@irori/core";
import { fmtBytes, fmtWatts } from "./analytics";
import { thresholds } from "./thresholds";

export interface CardRow {
  /** Stable v-for key: "gpu0" | "cpu" | "mem" | "disk". */
  key: string;
  label: string;
  barPct: number | null;
  /** Available-space share rendered as the trailing orange segment (disk rows only, IR-98). */
  freePct?: number;
  /** Compact visible value (IRI-159): no model names, no totals — e.g. "34% · 74 W". */
  line: string;
  /** Touch fallback (hover: none): the pre-IRI-159 full value with totals; absent when `line` already carries them. */
  lineFull?: string;
  /** Static row detail for the label tooltip (IRI-159); absent when the row has nothing to add. */
  tip?: string;
  /** Rendered after `line` with the hot-temp accent; null when unreadable. */
  tempC: number | null;
  /** Value renders with the hot accent (disk usage > 80 %); absent otherwise. */
  warn?: boolean;
}

export interface CardData {
  name: string;
  kind: string;
  role: string;
  online: boolean;
  /** "dot dot--run" (open circle) when online, "dot dot--halt" when not. */
  dotClass: string;
  statusText: string;
  agentVersion: string | null;
  hasSnapshot: boolean;
  /** Static identity string for the card-name tooltip (IRI-159): model · kind · agent · totals. Null when nothing readable. */
  identityTip: string | null;
  /** Importance order: sparks GPU → CPU → MEM, NAS Disk → MEM → CPU. */
  rows: CardRow[];
}

const GIB = 2 ** 30;

export function formatGiB(bytes: number | null): string | null {
  if (bytes === null) return null;
  return (bytes / GIB).toFixed(1);
}

export function formatPct(pct: number | null): string | null {
  if (pct === null) return null;
  return `${Math.round(pct)}%`;
}

export function formatTemp(tempC: number | null): string | null {
  if (tempC === null) return null;
  return `${Math.round(tempC)}°C`;
}

/** DS card metric line: join the readable segments with " · ", drop nulls. */
export function formatMetricLine(...parts: Array<string | null>): string {
  return parts.filter((p) => p !== null).join(" · ");
}

/** Hot-temp accent at the app-wide warn tier (70 °C, analytics.ts). */
export function isHotTemp(tempC: number | null): boolean {
  return tempC !== null && tempC >= thresholds.tempWarnC;
}

/**
 * Pure view model for NodeCard: all formatting/branching lives here so it is
 * testable without a DOM. The component only renders fields.
 */
export function computeCardData(
  node: NodeInfo,
  snapshot: HardwareSnapshot | null | undefined,
): CardData {
  const cpu = snapshot?.cpu ?? null;
  const memory = snapshot?.memory ?? null;

  const cpuPct = cpu?.usagePct ?? null;
  const memPct =
    memory && memory.totalBytes > 0
      ? (memory.usedBytes / memory.totalBytes) * 100
      : null;

  const memUsed = formatGiB(memory?.usedBytes ?? null);
  const memTotal = formatGiB(memory?.totalBytes ?? null);

  const cpuRow: CardRow = {
    key: "cpu",
    label: "CPU",
    barPct: cpuPct,
    line: formatMetricLine(formatPct(cpuPct)),
    lineFull: formatMetricLine(formatPct(cpuPct)),
    tip: cpu
      ? formatMetricLine(cpu.model, `${cpu.cores} cores`, "mean utilization across cores", "package watts on the Power card when readable")
      : undefined,
    tempC: cpu?.tempC ?? null,
  };
  const memRow: CardRow = {
    key: "mem",
    label: "MEM",
    barPct: memPct,
    line: memUsed === null ? "" : `${memUsed} GB`,
    lineFull: memUsed === null && memTotal === null ? undefined : `${memUsed ?? "?"} / ${memTotal ?? "?"} GB`,
    tip: memTotal === null ? "Unified memory · CPU and GPU share one pool" : `Unified memory · ${memTotal} GB total · CPU and GPU share one pool`,
    tempC: null,
  };

  const gpuRows: CardRow[] = (snapshot?.gpus ?? []).map((gpu) => {
    const memUsedGiB = formatGiB(gpu.memUsedBytes);
    const memTotalGiB = formatGiB(gpu.memTotalBytes);
    const vramPct =
      gpu.memUsedBytes !== null && gpu.memTotalBytes !== null && gpu.memTotalBytes > 0
        ? Math.round((gpu.memUsedBytes / gpu.memTotalBytes) * 100)
        : null;
    return {
      key: `gpu${gpu.index}`,
      label: `GPU${gpu.index}`,
      barPct: gpu.usagePct,
      // IRI-159: the model name and VRAM totals move to the label tooltip —
      // the compact value keeps only the live metric segments; lineFull keeps
      // the pre-IRI-159 value for touch users and the node detail page.
      line: formatMetricLine(formatPct(gpu.usagePct), gpu.powerW === null ? null : fmtWatts(gpu.powerW)),
      lineFull: formatMetricLine(
        gpu.name,
        formatPct(gpu.usagePct),
        gpu.powerW === null ? null : fmtWatts(gpu.powerW),
        memUsedGiB === null && memTotalGiB === null ? null : `${memUsedGiB ?? "?"} / ${memTotalGiB ?? "?"} GB`,
      ),
      tip: formatMetricLine(
        gpu.name,
        memUsedGiB === null && memTotalGiB === null
          ? null
          : `VRAM ${memUsedGiB ?? "?"} / ${memTotalGiB ?? "?"} GB${vramPct === null ? "" : ` (${vramPct}%)`}`,
        `per-node envelope ${GB10_SYSTEM_ENVELOPE_W} W`,
      ),
      tempC: gpu.tempC,
    };
  });

  // Device disk = the filesystem backing "/" (the internal NVMe on sparks);
  // mounted volumes (NAS shares) are ignored per owner rule 2026-10-25
  // (IR-98). NAS cards keep the largest-mount selection because the store
  // volume is the point there (the QNAP root is squashfs, never reported).
  // Snapshots without a "/" entry fall back to the largest real mount.
  const storage = snapshot?.storage ?? [];
  const deviceMount =
    node.kind === "nas"
      ? undefined
      : storage.find((s) => s.mount === "/" && s.totalBytes > 0);
  const bestMount =
    deviceMount ??
    storage.reduce<{ usedBytes: number; totalBytes: number } | null>(
      (acc, s) =>
        s.totalBytes > 0 && (acc === null || s.totalBytes > acc.totalBytes)
          ? { usedBytes: s.usedBytes, totalBytes: s.totalBytes }
          : acc,
      null,
    );
  let diskRow: CardRow | null = null;
  if (bestMount !== null) {
    const diskPctValue = Math.round((bestMount.usedBytes / bestMount.totalBytes) * 100);
    diskRow = {
      key: "disk",
      label: "DISK",
      barPct: (bestMount.usedBytes / bestMount.totalBytes) * 100,
      freePct: 100 - (bestMount.usedBytes / bestMount.totalBytes) * 100,
      line: fmtBytes(bestMount.usedBytes),
      lineFull: `${fmtBytes(bestMount.usedBytes)} / ${fmtBytes(bestMount.totalBytes)}`,
      tip:
        node.kind === "nas"
          ? `Store volume · ${fmtBytes(bestMount.totalBytes)} total · ${fmtBytes(Math.max(0, bestMount.totalBytes - bestMount.usedBytes))} free`
          : `Internal NVMe · ${fmtBytes(bestMount.totalBytes)} total · ${fmtBytes(Math.max(0, bestMount.totalBytes - bestMount.usedBytes))} free · orange = available share`,
      tempC: null,
      warn: diskPctValue >= thresholds.diskWarnPct,
    };
  }

  // Package power (M2 collector), bar scaled against the documented GB10 SOC
  // TDP (SPEC §9). Omitted entirely when the collector cannot read it.
  const pkgW = cpu?.packagePowerW ?? null;
  const pkgRow: CardRow | null =
    pkgW === null
      ? null
      : {
          key: "pkg",
          label: "PKG",
          barPct: Math.min(100, (pkgW / GB10_SOC_TDP_W) * 100),
          line: fmtWatts(pkgW),
          lineFull: fmtWatts(pkgW),
          tempC: null,
        };

  // IRI-159: static identity string for the card-name tooltip — carries what
  // the declutter removed from the visible card (kind, agent, totals).
  const identityTip = formatMetricLine(
    snapshot?.gpus?.[0]?.name ?? null,
    node.kind === "nas" ? "NAS storage" : "DGX Spark",
    node.agentVersion ? `agent ${node.agentVersion}` : null,
    memTotal === null ? null : `unified memory ${memTotal} GB`,
    bestMount !== null ? fmtBytes(bestMount.totalBytes) : null,
  );

  return {
    name: node.name,
    kind: node.kind,
    role: node.role,
    online: node.online,
    dotClass: node.online ? "dot dot--run" : "dot dot--halt",
    statusText: node.online ? "online" : "offline",
    agentVersion: node.agentVersion,
    hasSnapshot: snapshot !== null && snapshot !== undefined,
    identityTip: identityTip === "" ? null : identityTip,
    rows:
      snapshot === null || snapshot === undefined
        ? []
        : node.kind === "nas"
          ? [...(diskRow !== null ? [diskRow] : []), memRow, cpuRow]
          : [...gpuRows, cpuRow, memRow, ...(pkgRow !== null ? [pkgRow] : []), ...(diskRow !== null ? [diskRow] : [])],
  };
}
