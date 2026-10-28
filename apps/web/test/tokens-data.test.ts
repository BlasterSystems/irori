import { describe, expect, it } from "vitest";
import type { TokenMacroResponse } from "@irori/core";
import { TOKENS_RANGE_TABS, clusterRows, fmtHitPct, modelRows, nodeRows, trendValues } from "../src/tokens-data";

function fixture(): TokenMacroResponse {
  return {
    range: "24h",
    fleet: { total: 445, generated: 145, input: 300, cached: 142, cacheHitPct: 47.3 },
    clusters: [
      { id: "s1", name: "GLM TP-3", total: 430, generated: 140, input: 290, cached: 140, cacheHitPct: 48.3 },
      { id: "standalone", name: "standalone", total: 15, generated: 5, input: 10, cached: 2, cacheHitPct: 20 },
    ],
    nodes: [
      { id: "n1", name: "DGX-1", cluster: "GLM TP-3", total: 310, generated: 110, input: 200, cached: 50, cacheHitPct: 25 },
      { id: "n3", name: "DGX-3", cluster: null, total: 15, generated: 5, input: 10, cached: 2, cacheHitPct: 20 },
    ],
    models: [
      { model: "GLM-5.3-Flash-EXL3", total: 420, generated: 130, input: 290, cached: 140, cacheHitPct: 48.3 },
      { model: "ds4", total: 15, generated: 5, input: 10, cached: 2, cacheHitPct: 20 },
    ],
  };
}

describe("token macro helpers (IRI-040)", () => {
  it("renders cluster rows by name", () => {
    const rows = clusterRows(fixture());
    expect(rows.map((r) => [r.label, r.total, r.cacheHitPct])).toEqual([
      ["GLM TP-3", 430, 48.3],
      ["standalone", 15, 20],
    ]);
  });

  it("renders node rows with the cluster as the sub line, standalone marked", () => {
    const rows = nodeRows(fixture());
    expect(rows.map((r) => [r.label, r.sub, r.total])).toEqual([
      ["DGX-1", "GLM TP-3", 310],
      ["DGX-3", "standalone", 15],
    ]);
  });

  it("renders model rows keyed by model name", () => {
    const rows = modelRows(fixture());
    expect(rows.map((r) => r.label)).toEqual(["GLM-5.3-Flash-EXL3", "ds4"]);
    expect(rows[0]).toMatchObject({ total: 420, generated: 130, input: 290, cached: 140, cacheHitPct: 48.3 });
  });

  it("formats hit percentages with one decimal and an em dash for unknown", () => {
    expect(fmtHitPct(47.3333)).toBe("47.3%");
    expect(fmtHitPct(0)).toBe("0.0%");
    expect(fmtHitPct(null)).toBe("—");
    expect(fmtHitPct(undefined)).toBe("—");
  });

  it("exposes the owner's range labels (week/month) mapped onto the standard values", () => {
    expect(TOKENS_RANGE_TABS.map((t) => [t.value, t.label])).toEqual([
      ["30m", "30m"],
      ["1h", "1h"],
      ["4h", "4h"],
      ["24h", "24h"],
      ["7d", "week"],
      ["30d", "month"],
      ["90d", "90d"],
    ]);
  });

  it("folds the lens series into one fleet total-tokens trend (missing buckets gap)", () => {
    expect(
      trendValues([
        { key: "a", label: "A", points: [{ t: 1000, generated: 10, prompt: 5 }, { t: 2000, generated: 1, prompt: 1 }] },
        { key: "b", label: "B", points: [{ t: 1000, generated: 2, prompt: 3 }] },
      ]),
    ).toEqual([20, 2]);
    expect(trendValues([])).toEqual([]);
  });
});
