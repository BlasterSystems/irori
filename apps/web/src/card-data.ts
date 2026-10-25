import type { HardwareSnapshot, LlmPortSnapshot, NodeInfo } from "@irori/core";
import { GB10_SOC_TDP_W } from "@irori/core";
import { fmtBytes, fmtWatts, DISK_WARN_PCT, TEMPS_WARN_C } from "./analytics";
import { llmSummaryLine, nodeLlmPorts } from "./llm-data";

export interface CardRow {
  /** Stable v-for key: "gpu0" | "cpu" | "mem" | "disk". */
  key: string;
  label: string;
  barPct: number | null;
  /** Metric segments without the temperature: "NVIDIA GB10 · 34% · 42.1 / 127.0 GB". */
  line: string;
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
  /** Head cards only: ":8000 EXL3 · :8001 idle"; null when nothing to show. */
  inferenceLine: string | null;
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
  return tempC !== null && tempC >= TEMPS_WARN_C;
}

/**
 * Pure view model for NodeCard: all formatting/branching lives here so it is
 * testable without a DOM. The component only renders fields.
 */
export function computeCardData(
  node: NodeInfo,
  snapshot: HardwareSnapshot | null | undefined,
  llm?: { ports: LlmPortSnapshot[] } | null,
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
  const memLine =
    memUsed === null && memTotal === null
      ? ""
      : `${memUsed ?? "?"} / ${memTotal ?? "?"} GB`;

  const cpuRow: CardRow = {
    key: "cpu",
    label: "CPU",
    barPct: cpuPct,
    line: formatMetricLine(formatPct(cpuPct)),
    tempC: cpu?.tempC ?? null,
  };
  const memRow: CardRow = { key: "mem", label: "MEM", barPct: memPct, line: memLine, tempC: null };

  const gpuRows: CardRow[] = (snapshot?.gpus ?? []).map((gpu) => {
    const memUsedGiB = formatGiB(gpu.memUsedBytes);
    const memTotalGiB = formatGiB(gpu.memTotalBytes);
    return {
      key: `gpu${gpu.index}`,
      label: `GPU${gpu.index}`,
      barPct: gpu.usagePct,
      line: formatMetricLine(
        gpu.name,
        formatPct(gpu.usagePct),
        gpu.powerW === null ? null : fmtWatts(gpu.powerW),
        memUsedGiB === null && memTotalGiB === null
          ? null
          : `${memUsedGiB ?? "?"} / ${memTotalGiB ?? "?"} GB`,
      ),
      tempC: gpu.tempC,
    };
  });

  // Largest real mount — the store volume on a NAS (/mnt/nas on the QNAP
  // instance), the local disk on sparks (overview mockup round 5 renders
  // DISK on worker cards; > 80 % usage renders the value warn).
  const bestMount = (snapshot?.storage ?? []).reduce<{ usedBytes: number; totalBytes: number } | null>(
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
      line: `${fmtBytes(bestMount.usedBytes)} / ${fmtBytes(bestMount.totalBytes)}`,
      tempC: null,
      warn: diskPctValue >= DISK_WARN_PCT,
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
          tempC: null,
        };

  return {
    name: node.name,
    kind: node.kind,
    role: node.role,
    online: node.online,
    dotClass: node.online ? "dot dot--run" : "dot dot--halt",
    statusText: node.online ? "online" : "offline",
    agentVersion: node.agentVersion,
    hasSnapshot: snapshot !== null && snapshot !== undefined,
    inferenceLine:
      node.role === "head"
        ? llmSummaryLine(llm?.ports ?? null, nodeLlmPorts(node))
        : null,
    rows:
      snapshot === null || snapshot === undefined
        ? []
        : node.kind === "nas"
          ? [...(diskRow !== null ? [diskRow] : []), memRow, cpuRow]
          : [...gpuRows, cpuRow, memRow, ...(pkgRow !== null ? [pkgRow] : []), ...(diskRow !== null ? [diskRow] : [])],
  };
}
