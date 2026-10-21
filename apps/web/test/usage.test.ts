import { describe, expect, it } from "vitest";
import {
  activityCharts,
  errorGroupRows,
  fmtBucketShort,
  fmtDurationMs,
  fmtTokens,
  fmtTps,
  mergeLiveRequest,
  parseUsageHash,
  requestTier,
  statusText,
  tierChipClass,
  tokenMix,
  topModels,
  usageChart,
  usageHashFor,
} from "../src/usage";
import type { UsageEvent, UsageRequestRow } from "@irori/core";

function row(overrides: Partial<UsageRequestRow> = {}): UsageRequestRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    nodeId: "00000000-0000-4000-8000-0000000000aa",
    setupId: null,
    port: 8081,
    ts: 1_700_000_000_000,
    model: "GLM-5.3-Flash-EXL3",
    endpoint: "/v1/chat/completions",
    stream: true,
    status: 200,
    finishReason: "stop",
    error: null,
    errorSig: null,
    durationMs: 1000,
    ttftMs: 100,
    decodeTps: 42,
    promptTokens: 10,
    completionTokens: 20,
    cachedTokens: 5,
    reasoningTokens: 2,
    totalTokens: 30,
    engineMeta: null,
    reqBytes: 100,
    resBytes: 200,
    sourceAddr: "127.0.0.1",
    parts: [],
    receivedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("usage formatters", () => {
  it("formats compact token counts", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1221)).toBe("1.2k");
    expect(fmtTokens(12_345)).toBe("12k");
    expect(fmtTokens(3_400_000)).toBe("3.4M");
    expect(fmtTokens(null)).toBe("—");
  });

  it("formats durations, rates and buckets", () => {
    expect(fmtDurationMs(340)).toBe("340 ms");
    expect(fmtDurationMs(1500)).toBe("1.5 s");
    expect(fmtDurationMs(65_000)).toBe("1m 5s");
    expect(fmtDurationMs(null)).toBe("—");
    expect(fmtTps(41.25)).toBe("41.3 tok/s");
    expect(fmtTps(null)).toBe("—");
    expect(fmtBucketShort(Date.UTC(2026, 9, 20, 9, 0))).toBe("10-20 09:00");
  });
});

describe("usage URL state", () => {
  it("parses tab and range from the hash with fallbacks", () => {
    expect(parseUsageHash("#/usage?tab=errors&range=7d")).toEqual({ tab: "errors", range: "7d" });
    expect(parseUsageHash("#/usage")).toEqual({ tab: "overview", range: "24h" });
    expect(parseUsageHash("#/usage?tab=bogus&range=fortnight")).toEqual({ tab: "overview", range: "24h" });
    expect(usageHashFor("models", "90d")).toBe("#/usage?tab=models&range=90d");
  });
});

describe("usage rows and tiers", () => {
  it("classifies tiers: error beats warn beats ok", () => {
    expect(requestTier(row())).toBe("ok");
    expect(requestTier(row({ status: null }))).toBe("warn");
    expect(requestTier(row({ status: 429 }))).toBe("error");
    expect(requestTier(row({ error: "boom" }))).toBe("error");
    expect(tierChipClass("error")).toBe("chip--warn");
    expect(tierChipClass("warn")).toBe("chip--muted");
    expect(tierChipClass("ok")).toBe("chip--ok");
  });

  it("prefers the error message for the status cell", () => {
    expect(statusText(row())).toBe("stop");
    expect(statusText(row({ status: 429 }))).toBe("429");
    expect(statusText(row({ status: 500, error: "boom" }))).toBe("500");
  });
});

describe("usage charts", () => {
  it("builds a floored shared-domain chart with epoch-ms times", () => {
    const chart = usageChart(
      [
        { t: "2026-10-20T08:00:00.000Z", value: 2 },
        { t: "2026-10-20T09:00:00.000Z", value: 8 },
        { t: "2026-10-20T10:00:00.000Z", value: null },
      ],
      200,
      100,
    );
    expect(chart.paths).toHaveLength(1);
    expect(chart.times[1]).toBe(Date.UTC(2026, 9, 20, 9));
    expect(chart.yMin).toBe(0);
    expect(chart.yMax).toBe(8);
  });

  it("folds the overview series into activity charts", () => {
    const series = [
      { t: "2026-10-20T08:00:00.000Z", requests: 3, errors: 1, promptTokens: 1, completionTokens: 1, cachedTokens: 1, reasoningTokens: 1, totalTokens: 9, ttftP50Ms: 1, ttftP95Ms: 1, decodeTps: 1 },
      { t: "2026-10-20T09:00:00.000Z", requests: 5, errors: 0, promptTokens: 1, completionTokens: 1, cachedTokens: 1, reasoningTokens: 1, totalTokens: 15, ttftP50Ms: 1, ttftP95Ms: 1, decodeTps: 1 },
    ];
    const charts = activityCharts(series, 200, 100);
    expect(charts.requests.series[0]!.points).toEqual([3, 5]);
    expect(charts.errors.series[0]!.points).toEqual([1, 0]);
    expect(charts.tokens.series[0]!.points).toEqual([9, 15]);
  });
});

describe("usage tables", () => {
  it("computes token mix shares and sorts models for the selector", () => {
    const mix = tokenMix([
      { model: "a", requests: 1, errors: 0, promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, totalTokens: 25 },
      { model: "b", requests: 1, errors: 0, promptTokens: 1, completionTokens: 1, cachedTokens: 0, reasoningTokens: 0, totalTokens: 75 },
    ]);
    expect(mix.map((m) => m.share)).toEqual([0.25, 0.75]);
    expect(topModels([
      { model: "", requests: 1, errors: 0, totalTokens: 99, ttftP50Ms: null, ttftP95Ms: null, decodeTps: null },
      { model: "a", requests: 1, errors: 0, totalTokens: 1, ttftP50Ms: null, ttftP95Ms: null, decodeTps: null },
      { model: "b", requests: 1, errors: 0, totalTokens: 5, ttftP50Ms: null, ttftP95Ms: null, decodeTps: null },
    ], 6)).toEqual(["b", "a"]);
  });

  it("sorts error groups by count then recency", () => {
    const groups = errorGroupRows([
      { sig: "a", count: 2, firstSeenMs: 1, lastSeenMs: 2, sample: "", models: [], status: 500 },
      { sig: "b", count: 2, firstSeenMs: 1, lastSeenMs: 9, sample: "", models: [], status: 500 },
      { sig: "c", count: 9, firstSeenMs: 1, lastSeenMs: 1, sample: "", models: [], status: 500 },
    ]);
    expect(groups.map((g) => g.sig)).toEqual(["c", "b", "a"]);
  });

  it("merges live SSE frames newest-first without duplicates", () => {
    const base = [row({ id: "00000000-0000-4000-8000-000000000001" })];
    const event: UsageEvent = {
      type: "usage",
      serverTimeMs: 1_700_000_000_500,
      nodeId: "00000000-0000-4000-8000-0000000000aa",
      request: { ...row({ id: "00000000-0000-4000-8000-000000000002" }) },
    };
    const merged = mergeLiveRequest(base, event, 2);
    expect(merged.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"]);
    const capped = mergeLiveRequest(merged, { ...event, request: { ...row({ id: "00000000-0000-4000-8000-000000000003" }) } }, 2);
    expect(capped).toHaveLength(2);
    expect(capped[0]!.id).toBe("00000000-0000-4000-8000-000000000003");
  });
});
