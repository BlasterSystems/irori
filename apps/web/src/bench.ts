import {
  benchConfigFor,
  benchResultSchemaFor,
  benchTypeSchema,
  decodeBestLevel,
  formatContextSize,
  type BenchType,
  type DecodeResult,
  type PrefillResult,
  type QualityResult,
  type ToolevalResult,
} from "@irori/core";

/**
 * Benchmarks page (M6): API clients + pure shaping helpers. Results are
 * validated once at this boundary via the @irori/core contracts.
 */

export type { BenchType };
export type { DecodeResult, DecodeLevel, DecodeStreamResult } from "@irori/core";
export type { PrefillResult, PrefillSizeResult, PrefillSample } from "@irori/core";
export type { QualityResult, QualityItemResult, QualityCategory, QualityCompare, QualityCompareRow } from "@irori/core";
export type { ToolevalResult, ToolevalScenarioResult } from "@irori/core";
export { compareQualityRuns, decodeBestLevel, formatContextSize } from "@irori/core";

export interface BenchRun {
  id: string;
  type: BenchType;
  nodeId: string;
  status: "running" | "completed" | "failed" | "canceled";
  config: unknown;
  result: DecodeResult | PrefillResult | QualityResult | ToolevalResult | null;
  error: string | null;
  model: string | null;
  port: number | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
}

function parseRun(raw: unknown): BenchRun {
  if (typeof raw !== "object" || raw === null) throw new Error("malformed bench run");
  const o = raw as Record<string, unknown>;
  const type = benchTypeSchema.parse(o.type);
  return {
    id: String(o.id),
    type,
    nodeId: String(o.nodeId),
    status: o.status === "completed" || o.status === "failed" || o.status === "canceled" ? o.status : "running",
    config: benchConfigFor(type, o.config),
    result: parseResult(type, o.result),
    error: typeof o.error === "string" ? o.error : null,
    model: typeof o.model === "string" ? o.model : null,
    port: typeof o.port === "number" ? o.port : null,
    durationMs: typeof o.durationMs === "number" ? o.durationMs : null,
    createdAt: String(o.createdAt),
    finishedAt: typeof o.finishedAt === "string" ? o.finishedAt : null,
  };
}

function parseResult(type: BenchType, raw: unknown): BenchRun["result"] {
  if (raw === null || raw === undefined) return null;
  const parsed = benchResultSchemaFor(type).safeParse(raw);
  return parsed.success ? (parsed.data as BenchRun["result"]) : null;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`${url} failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchBenchRuns(type: BenchType, opts: { nodeId?: string; limit?: number } = {}, signal?: AbortSignal): Promise<BenchRun[]> {
  const params = new URLSearchParams();
  if (opts.nodeId) params.set("nodeId", opts.nodeId);
  if (opts.limit) params.set("limit", String(opts.limit));
  const suffix = params.toString();
  const body = (await getJson(`/api/v1/bench/${type}/runs${suffix ? `?${suffix}` : ""}`, signal)) as { runs?: unknown };
  if (typeof body !== "object" || body === null || !Array.isArray(body.runs)) throw new Error("malformed bench runs payload");
  return body.runs.map(parseRun);
}

export async function fetchBenchActive(signal?: AbortSignal): Promise<BenchRun[]> {
  const body = (await getJson("/api/v1/bench/active", signal)) as { runs?: unknown };
  if (typeof body !== "object" || body === null || !Array.isArray(body.runs)) throw new Error("malformed bench active payload");
  return body.runs.map(parseRun);
}

export async function startBench(type: BenchType, nodeId: string, config: Record<string, unknown>, signal?: AbortSignal): Promise<BenchRun> {
  const res = await fetch(`/api/v1/bench/${type}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, config }),
    signal,
  });
  if (res.status === 202) {
    const body = (await res.json()) as { run?: unknown };
    return parseRun(body.run);
  }
  let detail = "";
  try {
    const err = (await res.json()) as { error?: unknown };
    if (typeof err.error === "string") detail = `: ${err.error}`;
  } catch {
    /* body was not json */
  }
  throw new Error(`POST /api/v1/bench/${type} failed: HTTP ${res.status}${detail}`);
}

export async function cancelBenchRun(id: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/v1/bench/runs/${id}/cancel`, { method: "POST", signal });
  if (!res.ok) throw new Error(`cancel failed: HTTP ${res.status}`);
}

/* ── Shaping helpers (history rows, headline metrics) ──────────────────── */

export function benchStatusLabel(status: BenchRun["status"]): string {
  return status === "running" ? "running" : status;
}

/** History headline: peak aggregate tok/s, peak prefill tok/s, score %, or pass count. */
export function benchHeadline(run: BenchRun): string {
  if (run.status === "failed") return run.error?.slice(0, 60) ?? "failed";
  if (run.status === "canceled") return "—";
  const r = run.result;
  if (r === null) return "—";
  switch (run.type) {
    case "decode": {
      const best = decodeBestLevel(r as DecodeResult);
      return best ? `${best.aggregateDecodeTps.toFixed(1)} tok/s` : "—";
    }
    case "prefill": {
      const sizes = (r as PrefillResult).sizes.filter((s) => s.medianTps > 0);
      if (sizes.length === 0) return "—";
      const peak = sizes.reduce((a, b) => (b.medianTps > a.medianTps ? b : a), sizes[0]!);
      return `${peak.medianTps.toFixed(0)} tok/s @ ${formatContextSize(peak.tokens)}`;
    }
    case "quality": {
      const q = r as QualityResult;
      return q.total > 0 ? `${((100 * q.passed) / q.total).toFixed(1)}%` : "—";
    }
    case "tooleval": {
      const t = r as ToolevalResult;
      return t.total > 0 ? `${t.passed}/${t.total}` : "—";
    }
  }
}

/** Short config summary for the history table. */
export function benchConfigSummary(run: BenchRun): string {
  const c = run.config;
  if (c === null || typeof c !== "object") return "—";
  const cfg = c as Record<string, unknown>;
  const port = typeof cfg.port === "number" ? `:${cfg.port}` : "";
  const model = typeof cfg.model === "string" ? cfg.model.split("/").pop() : null;
  switch (run.type) {
    case "decode": {
      const conc = Array.isArray(cfg.concurrencies) ? (cfg.concurrencies as number[]).join("·") : "?";
      const type = typeof cfg.promptType === "string" ? cfg.promptType : "";
      return `×${conc} ${type}${model ? ` · ${model}` : ""}`;
    }
    case "prefill": {
      const sizes = Array.isArray(cfg.sizes) ? (cfg.sizes as number[]).map(formatContextSize).join("·") : "?";
      return `sweep ${sizes}${model ? ` · ${model}` : ""}`;
    }
    case "quality": {
      const cats = Array.isArray(cfg.categories) ? (cfg.categories as string[]).join("·") : "?";
      const conc = typeof cfg.concurrency === "number" ? ` ×${cfg.concurrency}` : "";
      return `quality ${cats}${conc}`;
    }
    case "tooleval":
      return `tool eval${port}`;
  }
}

export function benchTargetLabel(run: BenchRun): string {
  const c = run.config;
  const host = c !== null && typeof c === "object" && typeof (c as Record<string, unknown>).host === "string" ? (c as Record<string, unknown>).host : "127.0.0.1";
  return `${host}${run.port !== null ? `:${run.port}` : ""}`;
}

export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `today ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** Compare eligibility: two completed runs of the same type. */
export function canCompare(a: BenchRun | undefined, b: BenchRun | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.status === "completed" &&
    b.status === "completed" &&
    a.result !== null &&
    b.result !== null
  );
}
