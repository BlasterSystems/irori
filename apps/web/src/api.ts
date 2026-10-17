import { nodeInfoSchema, type NodeInfo } from "@irori/core";

/**
 * Fetch the node registry. Tolerates extra fields: nodeInfoSchema strips
 * unknown keys (zod default), so newer servers stay compatible.
 */
export async function fetchNodes(signal?: AbortSignal): Promise<NodeInfo[]> {
  const res = await fetch("/api/v1/nodes", {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`GET /api/v1/nodes failed: HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) {
    throw new Error("GET /api/v1/nodes: expected a JSON array of nodes");
  }
  return body.map((item) => nodeInfoSchema.parse(item));
}

/* ── Node history ─────────────────────────────────────────────────────── */

export type HistoryRange = "1h" | "24h" | "7d" | "30d" | "90d";

export const HISTORY_RANGES: readonly HistoryRange[] = [
  "1h",
  "24h",
  "7d",
  "30d",
  "90d",
];

export function isHistoryRange(value: string): value is HistoryRange {
  return (HISTORY_RANGES as readonly string[]).includes(value);
}

/** min/avg/max band (°C); each side nullable when the collector missed it. */
export interface TempBand {
  min: number | null;
  avg: number | null;
  max: number | null;
}

/**
 * One server-side history bucket, ascending by `t`. Usage %, watts and
 * bytes/s rates as collected; `mem`/`gpuMem` are absolute bytes (bucket
 * average, gpuMem summed across cards). Null = collector could not read it.
 */
export interface HistoryPoint {
  t: number;
  cpu: number | null;
  cpuTemp: TempBand;
  mem: number | null;
  gpu: number | null;
  gpuTemp: TempBand;
  gpuPowerW: number | null;
  gpuMem: number | null;
  netRx: number | null;
  netTx: number | null;
  samples: number | null;
}

export interface HistoryResponse {
  /** Server bucket size, verbatim DB enum: "minute" | "hour" | "day". */
  granularity: string;
  points: HistoryPoint[];
}

function isNumOrNull(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

function parseTempBand(v: unknown, field: string): TempBand {
  if (typeof v !== "object" || v === null) {
    throw new Error(`history: ${field} must be an object`);
  }
  const o = v as Record<string, unknown>;
  if (!isNumOrNull(o.min) || !isNumOrNull(o.avg) || !isNumOrNull(o.max)) {
    throw new Error(`history: ${field}.min/avg/max must be numbers or null`);
  }
  return { min: o.min, avg: o.avg, max: o.max };
}

/**
 * Validate a history payload. Hand-rolled (zod is not a web dependency) and
 * strict on shape but tolerant of unknown keys, like the rest of the client.
 */
export function parseHistoryResponse(body: unknown): HistoryResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("history: expected a JSON object");
  }
  const o = body as Record<string, unknown>;
  if (typeof o.granularity !== "string" || o.granularity.length === 0) {
    throw new Error("history: granularity must be a string");
  }
  if (!Array.isArray(o.points)) {
    throw new Error("history: points must be an array");
  }
  const points = o.points.map((raw): HistoryPoint => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("history: point must be an object");
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.t !== "number") {
      throw new Error("history: point.t must be a number");
    }
    for (const k of [
      "cpu",
      "mem",
      "gpu",
      "gpuPowerW",
      "gpuMem",
      "netRx",
      "netTx",
      "samples",
    ] as const) {
      if (!isNumOrNull(p[k])) {
        throw new Error(`history: point.${k} must be a number or null`);
      }
    }
    return {
      t: p.t,
      cpu: p.cpu as number | null,
      cpuTemp: parseTempBand(p.cpuTemp, "cpuTemp"),
      mem: p.mem as number | null,
      gpu: p.gpu as number | null,
      gpuTemp: parseTempBand(p.gpuTemp, "gpuTemp"),
      gpuPowerW: p.gpuPowerW as number | null,
      gpuMem: p.gpuMem as number | null,
      netRx: p.netRx as number | null,
      netTx: p.netTx as number | null,
      samples: p.samples as number | null,
    };
  });
  return { granularity: o.granularity, points };
}

export async function fetchHistory(
  nodeId: string,
  range: HistoryRange,
  signal?: AbortSignal,
): Promise<HistoryResponse> {
  const res = await fetch(
    `/api/v1/nodes/${encodeURIComponent(nodeId)}/history?range=${range}`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!res.ok) {
    throw new Error(
      `GET /api/v1/nodes/${nodeId}/history failed: HTTP ${res.status}`,
    );
  }
  const body: unknown = await res.json();
  return parseHistoryResponse(body);
}
