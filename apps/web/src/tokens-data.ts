/**
 * Token macro view helpers (IRI-040 / IR-118): pure functions the Tokens page
 * renders — rows for the three macro views (fleet tiles, by cluster/node,
 * by model) and the fleet trend folded from the analytics tokens lens.
 * Kept free of Vue so they unit-test directly.
 */
import type { TokenMacroResponse, TokenMacroRow } from "@irori/core";

/** One display row for the By-cluster / By-node / By-model tables. */
export interface MacroDisplayRow {
  key: string;
  label: string;
  /** Secondary line (e.g. the node's cluster in the By-node view). */
  sub: string | null;
  total: number;
  generated: number;
  input: number;
  cached: number;
  cacheHitPct: number;
}

function display(key: string, label: string, sub: string | null, r: TokenMacroRow): MacroDisplayRow {
  return { key, label, sub, total: r.total, generated: r.generated, input: r.input, cached: r.cached, cacheHitPct: r.cacheHitPct };
}

export function clusterRows(m: TokenMacroResponse): MacroDisplayRow[] {
  return m.clusters.map((c) => display(c.id, c.name, null, c));
}

export function nodeRows(m: TokenMacroResponse): MacroDisplayRow[] {
  return m.nodes.map((n) => display(n.id, n.name, n.cluster ?? "standalone", n));
}

export function modelRows(m: TokenMacroResponse): MacroDisplayRow[] {
  return m.models.map((mo) => display(mo.model, mo.model, null, mo));
}

/** Cache hit percentage with one decimal; `null` renders as an em dash. */
export function fmtHitPct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(1)}%`;
}

/** Owner-specified range labels: week = 7d, month = 30d. */
export const TOKENS_RANGE_TABS: ReadonlyArray<{ value: "30m" | "1h" | "4h" | "24h" | "7d" | "30d" | "90d"; label: string }> = [
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "week" },
  { value: "30d", label: "month" },
  { value: "90d", label: "90d" },
];

/**
 * Folds the analytics tokens lens series (per node or cluster) into ONE fleet
 * total-tokens trend for the Sparkline: per bucket, sum(generated + input)
 * across every series. Buckets missing in some series count what exists —
 * a bucket present in at least one series is never dropped.
 */
export function trendValues(
  series: Array<{
    key?: string;
    label?: string;
    points: Array<{ t: number; generated?: number | null; prompt?: number | null }>;
  }>,
): Array<number | null> {
  const acc = new Map<number, number>();
  for (const s of series) {
    for (const p of s.points) {
      const total = (p.generated ?? 0) + (p.prompt ?? 0);
      acc.set(p.t, (acc.get(p.t) ?? 0) + total);
    }
  }
  return [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}
