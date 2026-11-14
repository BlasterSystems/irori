/**
 * Token macro helpers for the Analytics tokens lens (IRI-040 / IR-118): pure
 * functions over the (additively extended) analytics response — fleet tiles,
 * per-group totals folded from the series, and model display rows. Free of
 * Vue so they unit-test directly.
 */
import type { AnalyticsResponse, TokenTotals } from "@irori/core";
import { fmtCount } from "./analytics";

/** One By-cluster/node totals row, folded from a lens series client-side. */
export interface SeriesTotalsRow {
  key: string;
  label: string;
  total: number;
  generated: number;
  input: number;
  cached: number;
  /** IRI-075: prompt minus cached — recomputed tokens. */
  computed: number;
  cacheHitPct: number;
}

function totalsRow(key: string, label: string, generated: number, prompt: number, cached: number): SeriesTotalsRow {
  return {
    key,
    label,
    total: generated + prompt,
    generated,
    input: prompt,
    cached,
    /** IRI-075: computed = prompt minus cached — the tokens that were actually
     *  recomputed (a 97% cache-hit run must not look like a full recompute). */
    computed: Math.max(0, prompt - cached),
    cacheHitPct: prompt > 0 ? Math.round((cached / prompt) * 1000) / 10 : 0,
  };
}

/** Per-group macro totals: sums each series' token buckets. */
export function seriesTotals(series: AnalyticsResponse["series"]): SeriesTotalsRow[] {
  const rows = series.map((s) => {
    let generated = 0;
    let prompt = 0;
    let cached = 0;
    for (const p of s.points) {
      generated += p.generated ?? 0;
      prompt += p.prompt ?? 0;
      cached += p.cached ?? 0;
    }
    return totalsRow(s.key, s.label, generated, prompt, cached);
  });
  return rows.sort((a, b) => b.total - a.total);
}

/** The six fleet stat tiles (IRI-075): prompt split into computed vs cached,
 *  plus the range cost from the server. `null` fleet → coverage reason, never
 *  an em dash (owner rule: no dash-filled labels). Counts go through fmtCount.
 *  `delta` is the % change vs the previous period; null = no comparison. */
export function fleetTiles(
  fleet: TokenTotals | null,
  costMinor = 0,
  costCurrency: string | null = null,
  deltaPct: number | null = null,
): Array<{ label: string; value: string; delta: number | null }> {
  const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };
  const dash = "—";
  const d = (v: number | null) => ({ delta: v });
  if (fleet === null) {
    return [
      { label: "Total tokens", value: "no token counters in range", ...d(null) },
      { label: "Generated", value: "—", ...d(null) },
      { label: "Input computed", value: "—", ...d(null) },
      { label: "Cached", value: "—", ...d(null) },
      { label: "Cache hit", value: "—", ...d(null) },
      { label: "Cost", value: costCurrency === null ? "Configure pricing" : "no data", ...d(null) },
    ];
  }
  const sym = costCurrency === null ? "" : CURRENCY_SYMBOLS[costCurrency] ?? "";
  const deltaLabel = deltaPct === null ? "" : ` · ${deltaPct > 0 ? "+" : ""}${Math.round(deltaPct * 10) / 10}% vs prev`;
  return [
    { label: "Total tokens", value: fmtCount(fleet.total) + deltaLabel, ...d(deltaPct) },
    { label: "Generated", value: fmtCount(fleet.generated), ...d(null) },
    { label: "Input computed", value: fmtCount(Math.max(0, fleet.prompt - fleet.cached)), ...d(null) },
    { label: "Cached", value: fmtCount(fleet.cached), ...d(null) },
    { label: "Cache hit", value: fmtHitPct(fleet.cacheHitPct), ...d(null) },
    { label: "Cost", value: sym === "" ? "Configure pricing" : `${sym}${((costMinor ?? 0) / 100).toFixed(2)}`, ...d(null) },
  ];
}

/**
 * Plain-English insight line — ONLY claims derivable from the data. Returns
 * null when there is nothing to claim (no counters in range).
 */
export function tokenInsight(
  fleet: TokenTotals | null,
  models: Array<{ model: string; total: number; cacheHitPct: number }>,
): string | null {
  if (fleet === null || fleet.total === 0 || models.length === 0) return null;
  const parts: string[] = [];
  const top = [...models].sort((a, b) => b.total - a.total)[0]!;
  parts.push(`${top.model} produced the most tokens in range (${fmtCount(top.total)})`);
  const withHits = models.filter((m) => m.total >= 10_000);
  if (withHits.length > 1) {
    const bestCache = [...withHits].sort((a, b) => b.cacheHitPct - a.cacheHitPct)[0]!;
    parts.push(`${bestCache.model} had the best cache hit (${fmtHitPct(bestCache.cacheHitPct)})`);
  }
  return parts.join(" · ") + ".";
}

/** CSV of the current per-model table (client-side, no new endpoint). */
export function modelsCsv(models: Array<{ model: string; total: number; generated: number; prompt: number; cached: number; cacheHitPct: number }>): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = ["model,total,generated,prompt,cached,cache_hit_pct"];
  for (const m of [...models].sort((a, b) => b.total - a.total)) {
    lines.push([esc(m.model), m.total, m.generated, m.prompt, m.cached, m.cacheHitPct].join(","));
  }
  return lines.join("\n") + "\n";
}

/** Cache hit percentage with one decimal; `null` renders as an em dash. */
export function fmtHitPct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(1)}%`;
}

// ─── Overview Token stats card (IR-224 S7 / IR-231) ─────────────────────────

export interface OverviewTokenTile {
  label: string;
  value: string;
  sub: string | null;
  /** % change vs the previous window — Total, Generated and Prompt only. */
  deltaPct: number | null;
  /** Points change vs the previous window — Cache hit only. */
  deltaPts: number | null;
}

/** Neutral totals shape the Overview card consumes (the web's spark-fold
 *  helper and the server fleet aggregate both map onto it). */
export interface OverviewTokenTotals {
  total: number;
  generated: number;
  prompt: number;
  cached: number;
}

function pctDelta(cur: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

function hitPctOf(t: OverviewTokenTotals | null): number | null {
  // IR-220: cache reads can be logged without a prompt row (capture gaps) —
  // clamp cached to prompt so the ratio and its delta stay ≤ 100%.
  if (t === null || t.prompt <= 0) return null;
  return (Math.min(t.cached, t.prompt) / t.prompt) * 100;
}

/**
 * The six Overview token tiles (IR-236): Total, Generated, Prompt (input),
 * Cache hit, Output:input, Cost. Deltas come from ONE previous-window fetch
 * (Total/Generated/Prompt in %, Cache hit in points); the folds are
 * client-side. `fleet === null` → coverage reasons, never dash-filled labels
 * (owner rule). Cost is server-priced (IRI-072).
 */
export function overviewTokenTiles(
  fleet: OverviewTokenTotals | null,
  prev: OverviewTokenTotals | null,
  costMinor: number | null,
  costCurrency: string | null,
): OverviewTokenTile[] {
  const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };
  const tile = (label: string, value: string, sub: string | null, deltaPct: number | null = null, deltaPts: number | null = null): OverviewTokenTile =>
    ({ label, value, sub, deltaPct, deltaPts });
  if (fleet === null) {
    return [
      tile("Total tokens", "no token counters in range", null),
      tile("Generated", "—", null),
      tile("Prompt (input)", "—", null),
      tile("Cache hit", "—", null),
      tile("Output : input", "—", null),
      tile("Cost", costCurrency === null ? "Configure pricing" : "no data", null),
    ];
  }
  const sym = costCurrency === null ? "" : CURRENCY_SYMBOLS[costCurrency] ?? "";
  const cost = costMinor === null
    ? costCurrency === null ? "Configure pricing" : "no data"
    : `≈ ${sym}${(costMinor / 100).toFixed(2)}`;
  const hit = hitPctOf(fleet);
  const prevHit = hitPctOf(prev);
  const ratio = fleet.generated > 0 ? `1 : ${Math.max(1, Math.round(fleet.prompt / fleet.generated))}` : "—";
  return [
    tile("Total tokens", fmtCount(fleet.total), "generated plus prompt", pctDelta(fleet.total, prev?.total)),
    tile("Generated", fmtCount(fleet.generated), null, pctDelta(fleet.generated, prev?.generated)),
    tile(
      "Prompt (input)",
      fmtCount(fleet.prompt),
      `${fmtCount(fleet.cached)} cached · ${fmtCount(Math.max(0, fleet.prompt - fleet.cached))} computed`,
      pctDelta(fleet.prompt, prev?.prompt),
    ),
    tile(
      "Cache hit",
      fmtHitPct(hit),
      hit === null ? null : `${fmtCount(Math.min(fleet.cached, fleet.prompt))} prefill tokens saved`,
      null,
      hit !== null && prevHit !== null ? Math.round((hit - prevHit) * 10) / 10 : null,
    ),
    tile("Output : input", ratio, null),
    tile("Cost", cost, "per-model pricing, server-side"),
  ];
}
