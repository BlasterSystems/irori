import { describe, expect, it } from "vitest";
import {
  benchConfigFor,
  compareQualityRuns,
  decodeBestLevel,
  decodeResultSchema,
  formatContextSize,
  mcnemarExactP,
  normalizeConcurrencies,
  normalizeContextSizes,
  prefillResultSchema,
  toolevalResultSchema,
  type DecodeResult,
  type QualityResult,
} from "../src/index.js";

describe("mcnemarExactP", () => {
  it("returns 1 when there are no discordant pairs", () => {
    expect(mcnemarExactP(0, 0)).toBe(1);
  });

  it("returns 1 for a single discordant pair in each direction", () => {
    expect(mcnemarExactP(1, 1)).toBe(1);
  });

  it("is exact for the (10, 1) table", () => {
    // 2 * [C(11,0)+C(11,1)] / 2^11 = 2*12/2048
    expect(mcnemarExactP(10, 1)).toBeCloseTo((2 * 12) / 2048, 12);
  });

  it("clamps to 1 for a saturated tail", () => {
    expect(mcnemarExactP(0, 5)).toBe(2 * (1 / 32));
  });

  it("ignores negative / fractional input", () => {
    expect(mcnemarExactP(-2, 1.9)).toBe(mcnemarExactP(0, 1));
  });
});

function qualityRun(_seed: string, suiteVersion = 1, scoringVersion = 1): QualityResult {
  // Stable item ids across runs — pairing is id-keyed.
  const item = (id: string, pass: boolean) => ({ id, category: "qa" as const, pass, error: null });
  return {
    suiteVersion,
    scoringVersion,
    total: 6,
    passed: 0,
    byCategory: { qa: { total: 6, passed: 0 } },
    items: [
      item("q-1", true),
      item("q-2", true),
      item("q-3", false),
      item("q-4", false),
      item("q-5", true),
      item("q-6", true),
    ],
  };
}

describe("compareQualityRuns", () => {
  it("pairs identical runs to zero discordance", () => {
    const a = qualityRun("r1");
    const b = qualityRun("r1");
    const cmp = compareQualityRuns(a, b);
    expect(cmp.verdict).toBe("noise");
    expect(cmp.onlyA).toBe(0);
    expect(cmp.onlyB).toBe(0);
    expect(cmp.note).toContain("Identical");
  });

  it("counts only-A and only-B discordant pairs", () => {
    const a = qualityRun("r1");
    const b = qualityRun("r2");
    b.items[0]!.pass = false; // only A right
    b.items[2]!.pass = true; // only B right
    const cmp = compareQualityRuns(a, b);
    expect(cmp.onlyA).toBe(1);
    expect(cmp.onlyB).toBe(1);
    expect(cmp.p).toBe(1);
  });

  it("excludes pairs with request errors from the counts", () => {
    const a = qualityRun("r1");
    const b = qualityRun("r1");
    b.items[0]!.error = "HTTP 500";
    b.items[0]!.pass = false;
    a.items[1]!.pass = false; // only B right
    const cmp = compareQualityRuns(a, b);
    expect(cmp.rows[0]!.excluded).toBe(1);
    expect(cmp.onlyA).toBe(0);
    expect(cmp.onlyB).toBe(1);
    expect(cmp.note).toContain("1 item pair excluded");
  });

  it("refuses to pair different suite/scoring versions", () => {
    const cmp = compareQualityRuns(qualityRun("r1", 1, 1), qualityRun("r1", 2, 1));
    expect(cmp.verdict).toBe("uncomparable");
    expect(cmp.note).toContain("different suite/scoring versions");
  });

  it("detects a beyond-noise winner", () => {
    const a = qualityRun("r1");
    const b = qualityRun("r2");
    for (const i of b.items) i.pass = false;
    for (const i of a.items) i.pass = true;
    // 6 discordant pairs all favoring A → exact p = 2/64 < 0.05
    const cmp = compareQualityRuns(a, b);
    expect(cmp.onlyA).toBe(6);
    expect(cmp.onlyB).toBe(0);
    expect(cmp.p).toBeLessThan(0.05);
    expect(cmp.verdict).toBe("a");
  });
});

describe("benchConfigFor", () => {
  it("parses per-type configs and applies defaults", () => {
    const decode = benchConfigFor("decode", { host: "spark1", port: 8080 });
    expect(decode).toMatchObject({ host: "spark1", port: 8080, maxTokens: 400, promptType: "structured" });
    const quality = benchConfigFor("quality", { host: "h", port: 1, model: null, categories: ["qa"], concurrency: 2 });
    expect(quality).toMatchObject({ categories: ["qa"], concurrency: 2 });
  });

  it("rejects configs that do not fit the bench", () => {
    expect(() => benchConfigFor("prefill", { host: "h", port: 1, sizes: [100] })).toThrow();
    expect(() => benchConfigFor("tooleval", { host: "h", port: 1, maxTokens: 400 })).toThrow();
  });

  it("rejects out-of-range values", () => {
    expect(() => benchConfigFor("decode", { host: "h", port: 1, maxTokens: 16 })).toThrow();
    expect(() => benchConfigFor("decode", { host: "h", port: 1, concurrencies: [64] })).toThrow();
    expect(() => benchConfigFor("prefill", { host: "h", port: 1, sizes: [128] })).toThrow();
    expect(() => benchConfigFor("quality", { host: "h", port: 1, concurrency: 64 })).toThrow();
  });
});

describe("normalize helpers", () => {
  it("dedupes and sorts concurrencies, dropping invalid entries", () => {
    expect(normalizeConcurrencies([8, 1, 8, 0, -1, 33, 4])).toEqual([1, 4, 8]);
    expect(normalizeConcurrencies("nope")).toEqual([]);
  });

  it("dedupes and sorts context sizes within 256–300k", () => {
    expect(normalizeContextSizes([300000, 1024, 1024, 128, 301000])).toEqual([1024, 300000]);
  });

  it("formats context sizes", () => {
    expect(formatContextSize(4096)).toBe("4k");
    expect(formatContextSize(300000)).toBe("300k");
    expect(formatContextSize(512)).toBe("512");
  });
});

describe("decodeBestLevel", () => {
  it("picks the peak aggregate level among levels with tokens", () => {
    const result: DecodeResult = {
      levels: [
        { concurrency: 1, aggregateDecodeTps: 30, totalDecodeTokens: 100 },
        { concurrency: 4, aggregateDecodeTps: 90, totalDecodeTokens: 400 },
        { concurrency: 8, aggregateDecodeTps: 0, totalDecodeTokens: 0 },
      ].map((l) => ({
        streamsOk: 1,
        streamsFailed: 0,
        meanDecodeTps: 30,
        medianDecodeTps: 30,
        minDecodeTps: 30,
        maxDecodeTps: 30,
        meanTtftMs: 10,
        medianTtftMs: 10,
        totalCompletionTokens: 100,
        durationMs: 1000,
        error: null,
        streams: [],
        ...l,
      })),
    };
    expect(decodeBestLevel(result)?.concurrency).toBe(4);
  });
});

describe("result schemas", () => {
  it("validate decode / prefill / tooleval shapes", () => {
    expect(
      decodeResultSchema.safeParse({
        levels: [
          {
            concurrency: 1, streamsOk: 1, streamsFailed: 0, meanDecodeTps: 1, medianDecodeTps: 1,
            minDecodeTps: 1, maxDecodeTps: 1, aggregateDecodeTps: 1, meanTtftMs: 1, medianTtftMs: 1,
            totalDecodeTokens: 1, totalCompletionTokens: 1, durationMs: 1, streams: [],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      prefillResultSchema.safeParse({
        overheadMs: 5,
        sizes: [{ tokens: 4096, repeats: 3, samples: [{ promptTokens: 100, cachedTokens: 0, ttftMs: 10, prefillTps: 9999, method: "ttft", lowConfidence: false }], medianTps: 9999, ttftMs: 10 }],
      }).success,
    ).toBe(true);
    expect(
      toolevalResultSchema.safeParse({
        total: 1,
        passed: 1,
        byCategory: { selection: { total: 1, passed: 1 }, params: { total: 0, passed: 0 }, multistep: { total: 0, passed: 0 }, safety: { total: 0, passed: 0 }, negative: { total: 0, passed: 0 } },
        scenarios: [{ id: "TS-01", title: "t", category: "selection", pass: true, turns: 1 }],
      }).success,
    ).toBe(true);
  });
});
