import type { HardwareSnapshot, LlmPortSnapshot, NodeInfo } from "@irori/core";
import { fmtBytes, TEMPS_WARN_C } from "./analytics";
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

/** Hot-temp accent, matching the analytics temps lens warn tier (85 °C). */
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
        memUsedGiB === null && memTotalGiB === null
          ? null
          : `${memUsedGiB ?? "?"} / ${memTotalGiB ?? "?"} GB`,
      ),
      tempC: gpu.tempC,
    };
  });

  // On a NAS the store volume is the whole point: surface the largest real
  // mount (/mnt/nas on the QNAP instance) as the first-class disk row. Sparks
  // keep their ≥80% disk chip instead — GPU/CPU/MEM dominate there.
  let diskRow: CardRow | null = null;
  if (node.kind === "nas") {
    const best = (snapshot?.storage ?? []).reduce<{ usedBytes: number; totalBytes: number } | null>(
      (acc, s) =>
        s.totalBytes > 0 && (acc === null || s.totalBytes > acc.totalBytes)
          ? { usedBytes: s.usedBytes, totalBytes: s.totalBytes }
          : acc,
      null,
    );
    if (best !== null) {
      diskRow = {
        key: "disk",
        label: "DISK",
        barPct: (best.usedBytes / best.totalBytes) * 100,
        line: `${fmtBytes(best.usedBytes)} / ${fmtBytes(best.totalBytes)}`,
        tempC: null,
      };
    }
  }

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
          : [...gpuRows, cpuRow, memRow],
  };
}
