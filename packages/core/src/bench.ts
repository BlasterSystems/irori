import { z } from "zod";

/**
 * Benchmarks (M6, SPEC §8). Four benches run in the agent against live
 * engines: decode (multi-concurrency streaming tok/s), prefill (context
 * sweep + TTFT), quality (seeded suite + paired compare), tooleval (agentic
 * tool-use trials). Protocols follow the sparkDash engines (see
 * docs/research/IRI-007-research-brief.md) — request shapes, not code.
 */

export const BENCH_TYPES = ["decode", "prefill", "quality", "tooleval"] as const;
export const benchTypeSchema = z.enum(BENCH_TYPES);
export type BenchType = (typeof BENCH_TYPES)[number];

/** Run status as persisted (agent-reported status maps onto completed/failed/canceled). */
export const benchStatusSchema = z.enum(["running", "completed", "failed", "canceled"]);
export type BenchStatus = z.infer<typeof benchStatusSchema>;

/** Concurrency levels a decode run may sweep (one wave per level, sequential). */
export const DECODE_CONCURRENCIES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24, 32] as const;
export const DECODE_DEFAULT_CONCURRENCIES = [1, 4, 8] as const;

/** Output types are prompt labels only — never response_format/grammars. */
export const DECODE_PROMPT_TYPES = ["structured", "prose", "code", "json"] as const;
export const decodePromptTypeSchema = z.enum(DECODE_PROMPT_TYPES);
export type DecodePromptType = z.infer<typeof decodePromptTypeSchema>;

/** Shared target: the live engine the agent streams against. */
const targetShape = {
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().positive(),
  model: z.string().min(1).nullable().default(null),
} as const;

export const decodeConfigSchema = z
  .object({
    ...targetShape,
    concurrencies: z
      .array(z.number().int().min(1).max(32))
      .min(1)
      .max(DECODE_CONCURRENCIES.length)
      .default([...DECODE_DEFAULT_CONCURRENCIES]),
    maxTokens: z.number().int().min(64).max(2048).default(400),
    promptType: decodePromptTypeSchema.default("structured"),
  })
  .strict();
export type DecodeConfig = z.infer<typeof decodeConfigSchema>;

export const PREFILL_MIN_CONTEXT_SIZE = 256;
export const PREFILL_MAX_CONTEXT_SIZE = 300_000;
export const PREFILL_CONTEXT_SIZES = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 300_000] as const;
export const PREFILL_DEFAULT_SIZES = [4096, 8192, 16384, 32768] as const;

export const prefillConfigSchema = z
  .object({
    ...targetShape,
    sizes: z
      .array(z.number().int().min(PREFILL_MIN_CONTEXT_SIZE).max(PREFILL_MAX_CONTEXT_SIZE))
      .min(1)
      .max(12)
      .default([...PREFILL_DEFAULT_SIZES]),
  })
  .strict();
export type PrefillConfig = z.infer<typeof prefillConfigSchema>;

export const QUALITY_CATEGORIES = ["qa", "reason", "arith", "track", "gsm8k", "mmlu"] as const;
export const qualityCategorySchema = z.enum(QUALITY_CATEGORIES);
export type QualityCategory = z.infer<typeof qualityCategorySchema>;
export const QUALITY_CATEGORY_LABELS: Record<QualityCategory, string> = {
  qa: "QA",
  reason: "Reasoning",
  arith: "Arithmetic chain",
  track: "State tracking",
  gsm8k: "GSM8K",
  mmlu: "MMLU",
};

export const qualityConfigSchema = z
  .object({
    ...targetShape,
    categories: z.array(qualityCategorySchema).min(1).max(QUALITY_CATEGORIES.length).default([...QUALITY_CATEGORIES]),
    concurrency: z.number().int().min(1).max(16).default(4),
  })
  .strict();
export type QualityConfig = z.infer<typeof qualityConfigSchema>;

export const toolevalConfigSchema = z.object({ ...targetShape }).strict();
export type ToolevalConfig = z.infer<typeof toolevalConfigSchema>;

/** Per-type config; the wire frame carries it untyped and each side parses by bench. */
export const benchConfigSchema = z.union([
  decodeConfigSchema,
  prefillConfigSchema,
  qualityConfigSchema,
  toolevalConfigSchema,
]);

/** Throttled progress (agent → server → SSE), ~1/s. */
export const benchProgressSchema = z.object({
  phase: z.enum(["starting", "running"]).default("running"),
  index: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0),
  label: z.string().default(""),
  /** Live tok/s from the run's own streams (decode waves); null when idle. */
  liveTps: z.number().nullable().default(null),
});
export type BenchProgress = z.infer<typeof benchProgressSchema>;

// ─── Results ─────────────────────────────────────────────

export const decodeStreamResultSchema = z.object({
  ttftMs: z.number().nullable(),
  decodeTps: z.number(),
  decodeTokens: z.number().int(),
  error: z.string().nullable(),
});
export type DecodeStreamResult = z.infer<typeof decodeStreamResultSchema>;

export const decodeLevelSchema = z.object({
  concurrency: z.number().int().positive(),
  streamsOk: z.number().int().nonnegative(),
  streamsFailed: z.number().int().nonnegative(),
  meanDecodeTps: z.number(),
  medianDecodeTps: z.number(),
  minDecodeTps: z.number(),
  maxDecodeTps: z.number(),
  /** Total decode tokens / concurrent first→last token window. */
  aggregateDecodeTps: z.number(),
  meanTtftMs: z.number(),
  medianTtftMs: z.number(),
  totalDecodeTokens: z.number().int().nonnegative(),
  totalCompletionTokens: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  error: z.string().nullable().default(null),
  streams: z.array(decodeStreamResultSchema).max(32).default([]),
});
export type DecodeLevel = z.infer<typeof decodeLevelSchema>;

export const decodeResultSchema = z.object({ levels: z.array(decodeLevelSchema).min(1) });
export type DecodeResult = z.infer<typeof decodeResultSchema>;

export const prefillSampleSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  ttftMs: z.number().nonnegative(),
  prefillTps: z.number().nonnegative(),
  method: z.enum(["server", "ttft"]),
  lowConfidence: z.boolean().default(false),
  reason: z.string().nullable().default(null),
});
export type PrefillSample = z.infer<typeof prefillSampleSchema>;

export const prefillSizeResultSchema = z.object({
  tokens: z.number().int().positive(),
  repeats: z.number().int().positive(),
  samples: z.array(prefillSampleSchema).min(1),
  medianTps: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
});
export type PrefillSizeResult = z.infer<typeof prefillSizeResultSchema>;

export const prefillResultSchema = z.object({
  /** Calibrated fixed per-request overhead (median of 3 tiny requests). */
  overheadMs: z.number().nonnegative(),
  sizes: z.array(prefillSizeResultSchema).min(1),
});
export type PrefillResult = z.infer<typeof prefillResultSchema>;

export const qualityItemResultSchema = z.object({
  id: z.string(),
  category: qualityCategorySchema,
  pass: z.boolean(),
  error: z.string().nullable().default(null),
});
export type QualityItemResult = z.infer<typeof qualityItemResultSchema>;

export const qualityResultSchema = z.object({
  suiteVersion: z.number().int().positive(),
  scoringVersion: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  byCategory: z.record(qualityCategorySchema, z.object({ total: z.number().int(), passed: z.number().int() })),
  items: z.array(qualityItemResultSchema).min(1),
});
export type QualityResult = z.infer<typeof qualityResultSchema>;

export const TOOLEVAL_CATEGORIES = ["selection", "params", "multistep", "safety", "negative"] as const;
export const toolevalCategorySchema = z.enum(TOOLEVAL_CATEGORIES);
export type ToolevalCategory = z.infer<typeof toolevalCategorySchema>;
export const TOOLEVAL_CATEGORY_LABELS: Record<ToolevalCategory, string> = {
  selection: "Tool selection",
  params: "Parameters",
  multistep: "Multi-step",
  safety: "Safety",
  negative: "No tool needed",
};

export const toolevalScenarioResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: toolevalCategorySchema,
  pass: z.boolean(),
  turns: z.number().int().nonnegative(),
  error: z.string().nullable().default(null),
});
export type ToolevalScenarioResult = z.infer<typeof toolevalScenarioResultSchema>;

export const toolevalResultSchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  byCategory: z.record(
    toolevalCategorySchema,
    z.object({ total: z.number().int(), passed: z.number().int() }),
  ),
  scenarios: z.array(toolevalScenarioResultSchema).min(1),
});
export type ToolevalResult = z.infer<typeof toolevalResultSchema>;

/** Result schema per bench type (run.result validation on read). */
export function benchResultSchemaFor(type: BenchType) {
  switch (type) {
    case "decode":
      return decodeResultSchema;
    case "prefill":
      return prefillResultSchema;
    case "quality":
      return qualityResultSchema;
    case "tooleval":
      return toolevalResultSchema;
  }
}

/** Parses a run's config blob by bench type. */
export function benchConfigFor(type: BenchType, raw: unknown): DecodeConfig | PrefillConfig | QualityConfig | ToolevalConfig {
  switch (type) {
    case "decode":
      return decodeConfigSchema.parse(raw);
    case "prefill":
      return prefillConfigSchema.parse(raw);
    case "quality":
      return qualityConfigSchema.parse(raw);
    case "tooleval":
      return toolevalConfigSchema.parse(raw);
  }
}

// ─── Frames ──────────────────────────────────────────────

/** Server → agent: run one benchmark against a live engine. */
export const benchRunRequestMsgSchema = z.object({
  type: z.literal("bench-run"),
  runId: z.string().uuid(),
  bench: benchTypeSchema,
  config: z.record(z.string(), z.unknown()),
});
export type BenchRunRequestMsg = z.infer<typeof benchRunRequestMsgSchema>;

export const benchCancelRequestMsgSchema = z.object({
  type: z.literal("bench-cancel"),
  runId: z.string().uuid(),
});
export type BenchCancelRequestMsg = z.infer<typeof benchCancelRequestMsgSchema>;

/** Agent → server: throttled progress for a running bench. */
export const benchProgressMsgSchema = z.object({
  type: z.literal("bench-progress"),
  runId: z.string().uuid(),
  progress: benchProgressSchema,
});
export type BenchProgressMsg = z.infer<typeof benchProgressMsgSchema>;

/** Agent → server: terminal frame; result present only on completed. */
export const benchDoneMsgSchema = z.object({
  type: z.literal("bench-done"),
  runId: z.string().uuid(),
  status: z.enum(["completed", "failed", "canceled"]),
  result: z.unknown().optional(),
  error: z.string().nullable().default(null),
});
export type BenchDoneMsg = z.infer<typeof benchDoneMsgSchema>;

// ─── Analysis helpers (pure; agent/web/server share) ─────

/** Exact two-sided McNemar p-value from discordant counts b and c:
 *  p = min(1, 2 · Σ_{i≤min(b,c)} C(b+c, i) / 2^(b+c)). */
export function mcnemarExactP(b: number, c: number): number {
  const nb = Math.max(0, Math.floor(Number(b) || 0));
  const nc = Math.max(0, Math.floor(Number(c) || 0));
  const n = nb + nc;
  if (n === 0) return 1;
  const lo = Math.min(nb, nc);
  let tail = 0;
  let binom = 1; // C(n, 0)
  for (let i = 0; i <= lo; i++) {
    if (i > 0) binom = (binom * (n - i + 1)) / i;
    tail += binom;
  }
  const p = Math.min(1, 2 * (tail / 2 ** n));
  return p;
}

export interface QualityCompareRow {
  category: QualityCategory;
  pctA: number | null;
  pctB: number | null;
  /** Items only A got right / only B got right (discordant pairs). */
  onlyA: number;
  onlyB: number;
  p: number;
  excluded: number;
}

export interface QualityCompare {
  rows: QualityCompareRow[];
  onlyA: number;
  onlyB: number;
  p: number;
  verdict: "a" | "b" | "noise" | "uncomparable";
  note: string | null;
}

/** Exact p-values are never 0 — render sub-resolution results as "<0.001". */
export function formatP(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

/**
 * Paired per-item compare of two quality runs. Rows are keyed by item id:
 * pairs missing from either run (request error) are excluded from the
 * discordant counts and reported via `excluded`.
 */
export function compareQualityRuns(a: QualityResult, b: QualityResult): QualityCompare {
  if (a.suiteVersion !== b.suiteVersion || a.scoringVersion !== b.scoringVersion) {
    return {
      rows: [],
      onlyA: 0,
      onlyB: 0,
      p: 1,
      verdict: "uncomparable",
      note: "Runs used different suite/scoring versions and cannot be paired.",
    };
  }
  const itemsA = new Map(a.items.map((i) => [i.id, i]));
  const itemsB = new Map(b.items.map((i) => [i.id, i]));
  const cats = [...new Set([...a.items.map((i) => i.category), ...b.items.map((i) => i.category)])] as QualityCategory[];
  const rows: QualityCompareRow[] = [];
  const totals = new Map<QualityCategory, { onlyA: number; onlyB: number }>();
  let excluded = 0;
  for (const cat of cats) {
    let onlyA = 0;
    let onlyB = 0;
    let catExcluded = 0;
    for (const [id, itemA] of itemsA) {
      if (itemA.category !== cat) continue;
      const itemB = itemsB.get(id);
      if (!itemB || itemA.error || itemB.error) {
        catExcluded++;
        continue;
      }
      if (itemA.pass && !itemB.pass) onlyA++;
      else if (!itemA.pass && itemB.pass) onlyB++;
    }
    excluded += catExcluded;
    const catA = a.byCategory[cat];
    const catB = b.byCategory[cat];
    rows.push({
      category: cat,
      pctA: catA && catA.total > 0 ? (100 * catA.passed) / catA.total : null,
      pctB: catB && catB.total > 0 ? (100 * catB.passed) / catB.total : null,
      onlyA,
      onlyB,
      p: mcnemarExactP(onlyA, onlyB),
      excluded: catExcluded,
    });
    const t = totals.get(cat) ?? { onlyA: 0, onlyB: 0 };
    t.onlyA += onlyA;
    t.onlyB += onlyB;
    totals.set(cat, t);
  }
  let onlyA = 0;
  let onlyB = 0;
  for (const t of totals.values()) {
    onlyA += t.onlyA;
    onlyB += t.onlyB;
  }
  const p = mcnemarExactP(onlyA, onlyB);
  const excludedNote = excluded > 0 ? ` ${excluded} item pair${excluded === 1 ? "" : "s"} excluded (request error).` : "";
  const note =
    onlyA + onlyB === 0
      ? `Identical outcomes on every paired item.${excludedNote}`
      : p >= 0.05
        ? `McNemar p = ${formatP(p)} — the difference is within noise.${excludedNote}`
        : `McNemar p = ${formatP(p)} — ${onlyA > onlyB ? "the first" : "the second"} run is better, beyond noise.${excludedNote}`;
  return { rows, onlyA, onlyB, p, verdict: onlyA + onlyB === 0 || p >= 0.05 ? "noise" : onlyA > onlyB ? "a" : "b", note };
}

/** Peak aggregate decode level (history headline). */
export function decodeBestLevel(result: DecodeResult): DecodeLevel | null {
  const ok = result.levels.filter((l) => l.totalDecodeTokens > 0 || l.totalCompletionTokens > 0);
  if (ok.length === 0) return null;
  return ok.reduce((best, l) => (l.aggregateDecodeTps > best.aggregateDecodeTps ? l : best), ok[0]!);
}

export function formatContextSize(tokens: number): string {
  const n = Number(tokens);
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

/** Concurrencies sorted + deduped; invalid entries dropped. */
export function normalizeConcurrencies(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 32))].sort(
    (a, b) => a - b,
  );
}

/** Sizes sorted + deduped within 256–300k; invalid entries dropped. */
export function normalizeContextSizes(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter(
        (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= PREFILL_MIN_CONTEXT_SIZE && v <= PREFILL_MAX_CONTEXT_SIZE,
      ),
    ),
  ].sort((a, b) => a - b);
}
