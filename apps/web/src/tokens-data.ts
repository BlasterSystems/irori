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

/** The five fleet stat tiles, display-ready values (`null` fleet → dashes).
 *  Counts go through fmtCount so large numbers render like the tables. */
export function fleetTiles(fleet: TokenTotals | null): Array<{ label: string; value: string }> {
  const dash = "—";
  return [
    { label: "Total tokens", value: fleet === null ? dash : fmtCount(fleet.total) },
    { label: "Generated", value: fleet === null ? dash : fmtCount(fleet.generated) },
    { label: "Input (prompt)", value: fleet === null ? dash : fmtCount(fleet.prompt) },
    { label: "Cache", value: fleet === null ? dash : fmtCount(fleet.cached) },
    { label: "Cache hit", value: fmtHitPct(fleet === null ? null : fleet.cacheHitPct) },
  ];
}

/** Cache hit percentage with one decimal; `null` renders as an em dash. */
export function fmtHitPct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(1)}%`;
}
