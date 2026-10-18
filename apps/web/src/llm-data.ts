import type { LlmBackend, LlmPortSnapshot, NodeInfo } from "@irori/core";

/**
 * Pure view-model shaping for the Inference surfaces (M3): per-port panels,
 * the head-card inference summary line and role-based cluster grouping.
 * DOM-free so it is unit-testable in the node env, like card-data.
 *
 * Backend semantics (IRI-004): null = the engine does not publish the metric
 * ("not detected"), never zero; workers probe detection-only, so their
 * snapshots carry backend/model/detected only.
 */

export const NULL_METRIC = "—";

const BACKEND_LABELS: Record<LlmBackend, string> = {
  vllm: "vLLM",
  "llama.cpp": "llama.cpp",
  sglang: "SGLang",
  exl3: "EXL3",
  tensorfold: "TensorFold",
  q27: "q27",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  ds4: "ds4",
  unknown: "unknown",
};

export function backendLabel(backend: LlmBackend): string {
  return BACKEND_LABELS[backend];
}

/** "142.3 tok/s" (one decimal, thousands-grouped); null → "—". */
export function formatTps(v: number | null): string {
  if (v === null) return NULL_METRIC;
  return `${v.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} tok/s`;
}

/** "3 running · 12 waiting"; null sides omitted; every side null → "—". */
export function formatQueue(running: number | null, waiting: number | null): string {
  const parts: string[] = [];
  if (running !== null) parts.push(`${running} running`);
  if (waiting !== null) parts.push(`${waiting} waiting`);
  return parts.length > 0 ? parts.join(" · ") : NULL_METRIC;
}

/** "84 ms" (rounded); null → "—". */
export function formatMs(v: number | null): string {
  if (v === null) return NULL_METRIC;
  return `${Math.round(v)} ms`;
}

/** "78%" (rounded); null → "—". */
export function formatKvPct(v: number | null): string {
  if (v === null) return NULL_METRIC;
  return `${Math.round(v)}%`;
}

/** Bar width 0–100 for the KV cache bar; null when unreadable. */
export function kvBarPct(v: number | null): number | null {
  if (v === null) return null;
  return Math.min(100, Math.max(0, v));
}

export interface EngineMetaRow {
  key: string;
  value: string;
}

function flattenMeta(
  src: object,
  prefix: string,
  depth: number,
  out: EngineMetaRow[],
): void {
  for (const [k, v] of Object.entries(src)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < 1) {
      flattenMeta(v, key, depth + 1, out);
    } else {
      out.push({ key, value: typeof v === "string" ? v : JSON.stringify(v) });
    }
  }
}

/** Flatten engineMeta (e.g. TensorFold live/streams blocks) into kv rows. */
export function engineMetaRows(
  meta: Record<string, unknown> | null | undefined,
): EngineMetaRow[] {
  if (!meta || typeof meta !== "object") return [];
  const out: EngineMetaRow[] = [];
  flattenMeta(meta, "", 0, out);
  return out;
}

export interface LlmPortView {
  port: number;
  /** Card head title, ":8000". */
  header: string;
  backendLabel: string;
  /** "chip--ok" when an engine answered, "chip--muted" while idle. */
  backendChipClass: string;
  /** "detected" | "idle" state chip text. */
  stateLabel: string;
  detected: boolean;
  /** True when the node probes detection-only (worker). */
  detectOnly: boolean;
  model: string | null;
  decodeLine: string;
  prefillLine: string;
  queueLine: string;
  kvBarPct: number | null;
  kvLine: string;
  ttftLine: string;
  engineMetaRows: EngineMetaRow[];
}

/**
 * Shape one port panel. A null/missing snapshot renders the idle placeholder
 * (configured port whose probe has not answered yet), never fabricated data.
 */
export function shapeLlmPort(
  snapshot: LlmPortSnapshot | null | undefined,
  port: number,
  opts: { detectOnly?: boolean } = {},
): LlmPortView {
  const s = snapshot ?? null;
  const detected = s?.detected ?? false;
  const kv = s?.kvCachePct ?? null;
  return {
    port,
    header: `:${port}`,
    backendLabel: backendLabel(s?.backend ?? "unknown"),
    backendChipClass: detected ? "chip--ok" : "chip--muted",
    stateLabel: detected ? "detected" : "idle",
    detected,
    detectOnly: opts.detectOnly ?? false,
    model: s?.model ?? null,
    decodeLine: formatTps(s?.decodeTps ?? null),
    prefillLine: formatTps(s?.prefillTps ?? null),
    queueLine: formatQueue(s?.queueRunning ?? null, s?.queueWaiting ?? null),
    kvBarPct: kvBarPct(kv),
    kvLine: formatKvPct(kv),
    ttftLine: formatMs(s?.ttftP95Ms ?? null),
    engineMetaRows: engineMetaRows(s?.engineMeta ?? null),
  };
}

/** llmPorts from the registry payload; tolerated absent on older servers. */
export function nodeLlmPorts(node: NodeInfo): number[] {
  if (!("llmPorts" in node)) return [];
  const raw: unknown = node.llmPorts;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0,
  );
}

export interface NodeGroups {
  heads: NodeInfo[];
  workers: NodeInfo[];
  standalone: NodeInfo[];
}

/**
 * M3 role-based cluster grouping (heads anchor the view); recipe-declared
 * clusters arrive with M5. Members stay ordered by sortOrder, then name.
 */
export function groupNodes(nodes: NodeInfo[]): NodeGroups {
  const sorted = [...nodes].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const groups: NodeGroups = { heads: [], workers: [], standalone: [] };
  for (const node of sorted) {
    if (node.role === "head") groups.heads.push(node);
    else if (node.role === "worker") groups.workers.push(node);
    else groups.standalone.push(node);
  }
  return groups;
}

/**
 * Head-card inference summary: ":8000 EXL3 · :8001 idle". Ports without a
 * probe yet are listed bare; detected ports not in the registry list are
 * appended (hot-added probes). Null when there is nothing to show.
 */
export function llmSummaryLine(
  ports: LlmPortSnapshot[] | null | undefined,
  configured: number[],
): string | null {
  const snapshots = ports ?? [];
  const ordered = [...configured];
  for (const snap of snapshots) {
    if (!ordered.includes(snap.port)) ordered.push(snap.port);
  }
  const parts = ordered.map((port) => {
    const snap = snapshots.find((p) => p.port === port);
    if (!snap) return `:${port}`;
    return snap.detected ? `:${port} ${backendLabel(snap.backend)}` : `:${port} idle`;
  });
  return parts.length > 0 ? parts.join(" · ") : null;
}
