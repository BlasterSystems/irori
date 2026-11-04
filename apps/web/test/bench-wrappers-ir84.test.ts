import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeLevelSchema, prefillResultSchema, toolevalResultSchema } from "@irori/core";
import {
  benchConfigSummary, benchHeadline, benchStatusLabel, cancelBenchRun,
  fetchBenchActive, fetchBenchRuns, fmtWhen, startBench,
} from "../src/bench";

/**
 * IRI-084: bench.ts wrapper contracts (runs/active/start/cancel + malformed
 * surfaces) and the headline/summary shaping branches.
 */

afterEach(() => vi.unstubAllGlobals());

const UUID = "11111111-1111-4111-8111-111111111111";
const iso = new Date().toISOString();

const level = decodeLevelSchema.parse({
  concurrency: 1, streamsOk: 4, streamsFailed: 0,
  meanDecodeTps: 30, medianDecodeTps: 30, minDecodeTps: 28, maxDecodeTps: 32,
  aggregateDecodeTps: 30, meanTtftMs: 200, medianTtftMs: 200,
  totalDecodeTokens: 100, totalCompletionTokens: 100, durationMs: 4000,
});

const run = {
  id: UUID, type: "decode", nodeId: UUID, status: "completed",
  config: { host: "127.0.0.1", port: 8081, model: "org/glm-5.3", promptType: "structured", concurrencies: [1] },
  result: { levels: [level] }, error: null, model: "glm-5.3", port: 8081,
  durationMs: 1000, createdAt: iso, finishedAt: iso,
};

const prefill = prefillResultSchema.parse({
  overheadMs: 5,
  sizes: [{ tokens: 8192, repeats: 1, ttftMs: 100, samples: [{ promptTokens: 8192, cachedTokens: 0, ttftMs: 100, prefillTps: 2000, method: "server" }], medianTps: 2000 }],
});

const tooleval = toolevalResultSchema.parse({ total: 4, passed: 3, byCategory: { selection: { total: 2, passed: 1 }, params: { total: 1, passed: 1 }, multistep: { total: 1, passed: 1 }, safety: { total: 0, passed: 0 }, negative: { total: 0, passed: 0 } }, scenarios: [{ id: "s1", title: "search", category: "selection", pass: true, turns: 2, error: null }] });

function res(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("bench wrappers", () => {
  it("fetchBenchRuns builds query params and parses runs", async () => {
    const f = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(`/api/v1/bench/decode/runs?nodeId=${UUID}&limit=5`);
      return res(200, { runs: [run] });
    });
    vi.stubGlobal("fetch", f);
    const runs = await fetchBenchRuns("decode", { nodeId: UUID, limit: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ type: "decode", status: "completed" });
  });

  it("fetchBenchActive parses; malformed payloads throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { runs: [run] })));
    expect(await fetchBenchActive()).toHaveLength(1);
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { runs: "x" })));
    await expect(fetchBenchActive()).rejects.toThrow("malformed bench active payload");
    vi.stubGlobal("fetch", vi.fn(async () => res(200, { runs: [null] })));
    await expect(fetchBenchRuns("decode")).rejects.toThrow("malformed bench run");
  });

  it("startBench returns the 202 run and surfaces error detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(202, { run })));
    await expect(startBench("decode", UUID, { port: 8081 })).resolves.toMatchObject({ status: "completed" });
    vi.stubGlobal("fetch", vi.fn(async () => res(409, { error: "node offline" })));
    await expect(startBench("decode", UUID, {})).rejects.toThrow("node offline");
    vi.stubGlobal("fetch", vi.fn(async () => res(500)));
    await expect(startBench("decode", UUID, {})).rejects.toThrow("HTTP 500");
  });

  it("cancelBenchRun tolerates ok and throws on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(cancelBenchRun(UUID)).resolves.toBeUndefined();
    vi.stubGlobal("fetch", vi.fn(async () => res(409)));
    await expect(cancelBenchRun(UUID)).rejects.toThrow("cancel failed: HTTP 409");
  });
});

describe("bench shaping helpers", () => {
  const mk = (over: Record<string, unknown>) => ({ ...run, ...over }) as never;

  it("benchHeadline covers every type and degenerate state", () => {
    expect(benchHeadline(mk({ status: "failed", error: "boom".repeat(30) }))).toBe("boom".repeat(15));
    expect(benchHeadline(mk({ status: "canceled" }))).toBe("—");
    expect(benchHeadline(mk({ result: null }))).toBe("—");
    expect(benchHeadline(mk({}))).toMatch(/tok\/s/); // decode best level
    expect(benchHeadline(mk({ type: "prefill", result: prefill }))).toContain("tok/s @");
    expect(benchHeadline(mk({ type: "tooleval", result: tooleval }))).toBe("3/4");
  });

  it("benchConfigSummary renders decode config and dashes for junk", () => {
    expect(benchConfigSummary(mk({}))).toContain("×1 structured · glm-5.3");
    expect(benchConfigSummary(mk({ config: null }))).toBe("—");
    expect(benchConfigSummary(mk({ config: "junk" }))).toBe("—");
  });

  it("benchStatusLabel and fmtWhen shape", () => {
    expect(benchStatusLabel("running")).toBe("running");
    expect(benchStatusLabel("completed")).toBe("completed");
    expect(fmtWhen(iso)).toMatch(/today|^\w{3} \d{1,2}/);
    expect(fmtWhen("2020-06-15T12:00:00Z")).toMatch(/^\w{3} 15/); // non-today branch
  });
});
