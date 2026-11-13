import { describe, expect, it } from "vitest";
import benchmarksViewSource from "../src/components/BenchmarksView.vue?raw";
import liveSource from "../src/live.ts?raw";
import {
  benchConfigSummary,
  benchHeadline,
  benchTargetLabel,
  canCompare,
  type BenchRun,
  type DecodeResult,
  type QualityResult,
  type ToolevalResult,
} from "../src/bench";

/* ── DS fidelity guard (same pattern as ds-markup.test.ts) ── */

it("BenchmarksView keeps the DS vocabulary", () => {
  for (const cls of ["pagehead", "tabs", "is-active", "card", "card__head", "card__body", "card__body--flush", "table", "chip", "dot--run", "dot--ok", "dot--halt", "dot--warn", "chip--ok", "chip--muted", "chip--warn", "btn--primary", "btn--sm", "bs-link--thread", "field", "input", "select", "mono", "faint", "stat__sub", "row--between", "label"]) {
    expect(benchmarksViewSource).toContain(cls);
  }
  expect(benchmarksViewSource).toContain("aria-label=\"Benchmark type\"");
});

it("live store ingests bench events into the benches map", () => {
  expect(liveSource).toContain("case \"bench\":");
  expect(liveSource).toContain("benches.set(event.runId");
});

/* ── Shaping helpers ── */

function run(over: Partial<BenchRun>): BenchRun {
  return {
    id: "r1",
    type: "decode",
    nodeId: "n1",
    status: "completed",
    config: { host: "spark1", port: 8080, model: null },
    result: null,
    error: null,
    model: null,
    port: 8080,
    durationMs: 1000,
    createdAt: "2026-10-18T09:00:00.000Z",
    finishedAt: null,
    ...over,
  };
}

const decodeResult: DecodeResult = {
  levels: [
    { concurrency: 1, streamsOk: 1, streamsFailed: 0, meanDecodeTps: 30, medianDecodeTps: 30, minDecodeTps: 30, maxDecodeTps: 30, aggregateDecodeTps: 30, meanTtftMs: 10, medianTtftMs: 10, totalDecodeTokens: 100, totalCompletionTokens: 101, durationMs: 1000, error: null, streams: [] },
    { concurrency: 4, streamsOk: 4, streamsFailed: 0, meanDecodeTps: 25, medianDecodeTps: 25, minDecodeTps: 20, maxDecodeTps: 30, aggregateDecodeTps: 90, meanTtftMs: 40, medianTtftMs: 40, totalDecodeTokens: 400, totalCompletionTokens: 404, durationMs: 2000, error: null, streams: [] },
  ],
};

describe("benchHeadline", () => {
  it("reports the peak aggregate decode level", () => {
    expect(benchHeadline(run({ type: "decode", result: decodeResult }))).toBe("90.0 tok/s");
  });

  it("reports prefill peak size, quality % and tooleval pass count", () => {
    expect(benchHeadline(run({ type: "prefill", result: { overheadMs: 5, sizes: [{ tokens: 4096, repeats: 3, samples: [], medianTps: 1234, ttftMs: 10 }, { tokens: 8192, repeats: 3, samples: [], medianTps: 2000, ttftMs: 10 }] } }))).toBe("2000 tok/s @ 8k");
    const emptyQualityCats = { qa: { total: 0, passed: 0 }, reason: { total: 0, passed: 0 }, arith: { total: 0, passed: 0 }, track: { total: 0, passed: 0 }, gsm8k: { total: 0, passed: 0 }, mmlu: { total: 0, passed: 0 } };
    expect(benchHeadline(run({ type: "quality", result: { suiteVersion: 1, scoringVersion: 1, total: 4, passed: 3, byCategory: { ...emptyQualityCats, qa: { total: 4, passed: 3 } }, items: [] } }))).toBe("75.0%");
    expect(benchHeadline(run({ type: "tooleval", result: { total: 20, passed: 4, byCategory: { selection: { total: 0, passed: 0 }, params: { total: 0, passed: 0 }, multistep: { total: 0, passed: 0 }, safety: { total: 0, passed: 0 }, negative: { total: 0, passed: 0 } }, scenarios: [] } }))).toBe("4/20");
  });

  it("falls back to error/status text", () => {
    expect(benchHeadline(run({ status: "failed", error: "HTTP 500" }))).toBe("HTTP 500");
    expect(benchHeadline(run({ status: "running", result: null }))).toBe("—");
  });
});

describe("benchConfigSummary", () => {
  it("summarizes decode, prefill, quality and tooleval configs", () => {
    expect(benchConfigSummary(run({ type: "decode", config: { host: "h", port: 8080, model: "org/GLM-5.3-Flash-EXL3", concurrencies: [1, 4, 8], promptType: "structured" } }))).toBe("×1·4·8 structured · GLM-5.3-Flash-EXL3");
    expect(benchConfigSummary(run({ type: "prefill", config: { host: "h", port: 8080, model: null, sizes: [4096, 8192] } }))).toBe("sweep 4k·8k");
    expect(benchConfigSummary(run({ type: "quality", config: { host: "h", port: 8080, model: null, categories: ["qa", "mmlu"], concurrency: 4 } }))).toBe("quality qa·mmlu ×4");
    expect(benchConfigSummary(run({ type: "tooleval", config: { host: "h", port: 8080, model: null } }))).toBe("tool eval:8080");
  });
});

describe("benchTargetLabel", () => {
  it("joins host and port", () => {
    expect(benchTargetLabel(run({}))).toBe("spark1:8080");
  });
});

describe("canCompare", () => {
  it("only pairs completed runs with results", () => {
    expect(canCompare(run({}), run({}))).toBe(false); // result null
    const withResult = run({ result: decodeResult });
    expect(canCompare(withResult, run({ result: decodeResult }))).toBe(true);
    expect(canCompare(withResult, run({ status: "failed", result: decodeResult }))).toBe(false);
  });
});
