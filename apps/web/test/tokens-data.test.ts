import { describe, expect, it } from "vitest";
import type { AnalyticsResponse, TokenTotals } from "@irori/core";
import { fleetTiles, fmtHitPct, modelsCsv, seriesTotals, tokenInsight } from "../src/tokens-data";

function fixture(): AnalyticsResponse {
  return {
    lens: "tokens",
    range: "24h",
    groupBy: "cluster",
    granularity: "hour",
    fleet: { total: 445, generated: 145, prompt: 300, cached: 142, cacheHitPct: 47.3 },
    series: [
      {
        key: "s1",
        label: "GLM TP-3",
        points: [
          { t: 1000, generated: 100, prompt: 200, cached: 50 },
          { t: 2000, generated: 40, prompt: 90, cached: 90 },
        ],
      },
      { key: "standalone", label: "standalone", points: [{ t: 1000, generated: 5, prompt: 10, cached: 2 }] },
    ],
    models: [
      { model: "GLM-5.3-Flash-EXL3", total: 420, generated: 130, prompt: 290, cached: 140, cacheHitPct: 48.3 },
      { model: "q27", total: 10, generated: 10, prompt: 0, cached: 0, cacheHitPct: 0 },
    ],
  } as AnalyticsResponse;
}

describe("token macro helpers (IRI-040)", () => {
  it("folds per-group totals from the lens series, sorted by total", () => {
    const rows = seriesTotals(fixture().series);
    expect(rows.map((r) => [r.label, r.total, r.generated, r.input, r.cached, r.cacheHitPct])).toEqual([
      ["GLM TP-3", 430, 140, 290, 140, 48.3],
      ["standalone", 15, 5, 10, 2, 20],
    ]);
  });

  it("treats missing token counters as zero in group totals", () => {
    const rows = seriesTotals([
      { key: "n", label: "N", points: [{ t: 1 }, { t: 2, generated: 3, prompt: 4 }] },
    ] as AnalyticsResponse["series"]);
    expect(rows).toEqual([{ key: "n", label: "N", total: 7, generated: 3, input: 4, cached: 0, computed: 4, cacheHitPct: 0 }]);
  });

  it("builds the six fleet tiles (computed/cached split, cost) with reasons instead of dashes", () => {
    const fleet: TokenTotals = { total: 445, generated: 145, prompt: 300, cached: 142, cacheHitPct: 47.3 };
    expect(fleetTiles(fleet).map((t) => t.value)).toEqual(["445", "145", "158", "142", "47.3%", "Configure pricing"]);
    // Large counts render like the tables (fmtCount), never raw digits.
    const big: TokenTotals = { total: 1234567, generated: 234567, prompt: 1000000, cached: 0, cacheHitPct: 0 };
    expect(fleetTiles(big).map((t) => t.value)).toEqual(["1.2M", "234.6k", "1.0M", "0", "0.0%", "Configure pricing"]);
    // Unset fleet: coverage reasons, never dash-filled labels (owner rule).
    expect(fleetTiles(null)[0]!.value).toBe("no token counters in range");
    // Cost tile with a currency.
    expect(fleetTiles(fleet, 1234, "EUR")[5]!.value).toBe("€12.34");
  });

  it("derives the insight line only from data (a wrong claim fails)", () => {
    const fleet: TokenTotals = { total: 430, generated: 140, prompt: 290, cached: 140, cacheHitPct: 48.3 };
    const models = [
      { model: "GLM-5.3-Flash-EXL3", total: 420, cacheHitPct: 48.3 },
      { model: "q27", total: 10, cacheHitPct: 0 },
    ];
    const line = tokenInsight(fleet, models)!;
    expect(line).toContain("GLM-5.3-Flash-EXL3 produced the most tokens in range");
    expect(line).not.toContain("q27 produced"); // q27 is not the top model
    // Below the 10k prompt threshold: no cache-hit claim.
    expect(line).not.toContain("best cache hit");
    const big = [
      { model: "glm", total: 500_000, cacheHitPct: 20 },
      { model: "qwen", total: 400_000, cacheHitPct: 90 },
    ];
    expect(tokenInsight(fleet, big)).toContain("qwen had the best cache hit (90.0%)");
    expect(tokenInsight(null, models)).toBeNull();
  });

  it("exports the per-model table as CSV (sorted by total, quoted when needed)", () => {
    const csv = modelsCsv([
      { model: "b", total: 2, generated: 1, prompt: 1, cached: 0, cacheHitPct: 0 },
      { model: 'a,"x"', total: 5, generated: 5, prompt: 0, cached: 0, cacheHitPct: 0 },
    ]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("model,total,generated,prompt,cached,cache_hit_pct");
    expect(lines[1]).toBe('"a,""x""",5,5,0,0,0'); // sorted desc by total, quoted
    expect(lines[2]).toBe("b,2,1,1,0,0");
  });

  it("formats hit percentages with one decimal and an em dash for unknown", () => {
    expect(fmtHitPct(47.3333)).toBe("47.3%");
    expect(fmtHitPct(0)).toBe("0.0%");
    expect(fmtHitPct(null)).toBe("—");
    expect(fmtHitPct(undefined)).toBe("—");
  });
});
