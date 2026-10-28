import { describe, expect, it } from "vitest";
import type { AnalyticsResponse, TokenTotals } from "@irori/core";
import { fleetTiles, fmtHitPct, seriesTotals } from "../src/tokens-data";

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
    expect(rows).toEqual([{ key: "n", label: "N", total: 7, generated: 3, input: 4, cached: 0, cacheHitPct: 0 }]);
  });

  it("builds the five fleet tiles, dashed when the fleet row is absent", () => {
    const fleet: TokenTotals = { total: 445, generated: 145, prompt: 300, cached: 142, cacheHitPct: 47.3 };
    expect(fleetTiles(fleet).map((t) => t.value)).toEqual(["445", "145", "300", "142", "47.3%"]);
    // Large counts render like the tables (fmtCount), never raw digits.
    const big: TokenTotals = { total: 1234567, generated: 234567, prompt: 1000000, cached: 0, cacheHitPct: 0 };
    expect(fleetTiles(big).map((t) => t.value)).toEqual(["1.2M", "234.6k", "1.0M", "0", "0.0%"]);
    expect(fleetTiles(null).every((t) => t.value === "—")).toBe(true);
  });

  it("formats hit percentages with one decimal and an em dash for unknown", () => {
    expect(fmtHitPct(47.3333)).toBe("47.3%");
    expect(fmtHitPct(0)).toBe("0.0%");
    expect(fmtHitPct(null)).toBe("—");
    expect(fmtHitPct(undefined)).toBe("—");
  });
});
