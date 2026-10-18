import type { HardwareSnapshot, LlmPortSnapshot, NodeInfo } from "@irori/core";
import { llmSummaryLine, nodeLlmPorts } from "./llm-data";

export interface GpuCardData {
  index: number;
  name: string;
  barPct: number | null;
  /** "34% · 61°C · 42.1 / 127.0 GB" — segments omitted when unreadable. */
  line: string;
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
  cpuBarPct: number | null;
  /** "18% · 62°C" — temp segment omitted when unreadable. */
  cpuLine: string;
  memBarPct: number | null;
  /** "96.0 / 127.0 GB" (GiB, one decimal). */
  memLine: string;
  /** Head cards only: ":8000 EXL3 · :8001 idle"; null when nothing to show. */
  inferenceLine: string | null;
  gpus: GpuCardData[];
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

  const gpus: GpuCardData[] = (snapshot?.gpus ?? []).map((gpu) => {
    const memUsedGiB = formatGiB(gpu.memUsedBytes);
    const memTotalGiB = formatGiB(gpu.memTotalBytes);
    return {
      index: gpu.index,
      name: gpu.name,
      barPct: gpu.usagePct,
      line: formatMetricLine(
        formatPct(gpu.usagePct),
        formatTemp(gpu.tempC),
        memUsedGiB === null && memTotalGiB === null
          ? null
          : `${memUsedGiB ?? "?"} / ${memTotalGiB ?? "?"} GB`,
      ),
    };
  });

  return {
    name: node.name,
    kind: node.kind,
    role: node.role,
    online: node.online,
    dotClass: node.online ? "dot dot--run" : "dot dot--halt",
    statusText: node.online ? "online" : "offline",
    agentVersion: node.agentVersion,
    hasSnapshot: snapshot !== null && snapshot !== undefined,
    cpuBarPct: cpuPct,
    cpuLine: formatMetricLine(formatPct(cpuPct), formatTemp(cpu?.tempC ?? null)),
    memBarPct: memPct,
    memLine:
      memUsed === null && memTotal === null
        ? ""
        : `${memUsed ?? "?"} / ${memTotal ?? "?"} GB`,
    inferenceLine:
      node.role === "head"
        ? llmSummaryLine(llm?.ports ?? null, nodeLlmPorts(node))
        : null,
    gpus,
  };
}
