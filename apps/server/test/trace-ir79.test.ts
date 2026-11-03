import { describe, expect, it } from "vitest";
import { timingFromEngineMeta, requestTraceOf } from "../src/usage-store.js";

/**
 * IRI-079 (IR-170): the timing parser and the span-tree builder.
 * Segments must sum to durationMs; TensorFold speculative fields type out of
 * the engineMeta blob; non-TensorFold rows degrade to two segments.
 */

describe("timingFromEngineMeta", () => {
  it("lifts speculative and timing fields from nested TensorFold engineMeta", () => {
    const meta = {
      model: "GLM-5.3-Flash-EXL3",
      timing: { prefill_ms: 39000, decode_ms: 93000 },
      speculative: { rounds: 12, drafted: 480, accepted: 402 },
    };
    expect(timingFromEngineMeta(meta)).toEqual({ prefillMs: 39000, decodeMs: 93000, specRounds: 12, specDrafted: 480, specAccepted: 402 });
  });

  it("returns nulls for unknown shapes (verbatim blob stays)", () => {
    expect(timingFromEngineMeta({ foo: "bar", nested: { x: 1 } })).toEqual({ prefillMs: null, decodeMs: null, specRounds: null, specDrafted: null, specAccepted: null });
    expect(timingFromEngineMeta(null)).toEqual({ prefillMs: null, decodeMs: null, specRounds: null, specDrafted: null, specAccepted: null });
  });
});

describe("requestTraceOf", () => {
  const base = { id: "00000000-0000-4000-8000-000000000001", node_id: "00000000-0000-4000-8000-0000000000aa", model: "glm", duration_ms: 132000, ttft_ms: 39000 };

  it("splits prefill/decode when the breakdown exists (segments sum to duration)", () => {
    const trace = requestTraceOf({ ...base, prefill_ms: 39000, decode_ms: 93000, spec_rounds: 12, spec_drafted: 480, spec_accepted: 402 });
    expect(trace.spans).toHaveLength(2);
    expect(trace.spans[0]).toMatchObject({ name: "queue + prefill", startMs: 0, endMs: 39000 });
    expect(trace.spans[1]).toMatchObject({ name: "decode", startMs: 39000, endMs: 132000 });
    const sum = trace.spans.reduce((a, s) => a + (s.endMs - s.startMs), 0);
    expect(sum).toBe(trace.durationMs);
    expect(trace.spans[1]!.attrs).toEqual({ specRounds: 12, specDrafted: 480, specAccepted: 402, acceptanceRate: 83.8 });
  });

  it("degrades to two segments from TTFT alone (non-TensorFold engines)", () => {
    const trace = requestTraceOf({ ...base, ttft_ms: 500 });
    expect(trace.spans).toHaveLength(2);
    expect(trace.spans[0]).toMatchObject({ name: "queue + prefill (TTFT)", startMs: 0, endMs: 500 });
    expect(trace.spans[1]).toMatchObject({ startMs: 500, endMs: 132000, attrs: {} });
    const sum = trace.spans.reduce((a, s) => a + (s.endMs - s.startMs), 0);
    expect(sum).toBe(trace.durationMs);
  });
});
