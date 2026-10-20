import { describe, expect, it } from "vitest";
import {
  CAPTURED_ENDPOINT_RE,
  MAX_USAGE_BATCH,
  normalizeErrorSignature,
  usageBatchAckMsgSchema,
  usageBatchMsgSchema,
  usageRequestSchema,
} from "../src/usage.js";

describe("usage contracts", () => {
  it("round-trips a captured request", () => {
    const parsed = usageRequestSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      ts: 1_700_000_000_000,
      setupId: null,
      port: 8081,
      model: "GLM-5.3-Flash-EXL3",
      endpoint: "/v1/chat/completions",
      stream: true,
      status: 200,
      finishReason: "stop",
      error: null,
      errorSig: null,
      durationMs: 1000,
      ttftMs: 120,
      decodeTps: 40.5,
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 10,
      reasoningTokens: 5,
      totalTokens: 150,
      engineMeta: { prefill_s: 0.7 },
      reqBytes: 1000,
      resBytes: 2000,
      sourceAddr: "127.0.0.1",
    });
    expect(parsed.totalTokens).toBe(150);
  });

  it("accepts not-detected fields as null and rejects a zero port", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000002",
      ts: 1,
      port: 8081,
      endpoint: "/v1/completions",
      reqBytes: 0,
      resBytes: 0,
    };
    const sparse = usageRequestSchema.parse({ ...base, status: null, model: null });
    expect(sparse.model).toBeNull();
    expect(sparse.status).toBeNull();
    expect(() => usageRequestSchema.parse({ ...base, port: 0 })).toThrow();
  });

  it("normalizes error signatures for grouping", () => {
    expect(normalizeErrorSignature("Model 'nope' not found (req 7f3a2b10-1234-4abc-9def-0123456789ab, attempt 2)")).toBe(
      "Model 'nope' not found (req U, attempt N)",
    );
    expect(normalizeErrorSignature("token 0xdeadbeefdeadbeef exceeded  42\tms")).toBe("token H exceeded N ms");
    expect(normalizeErrorSignature("   ")).toBe("");
  });

  it("bounds batch frames and validates acks", () => {
    expect(MAX_USAGE_BATCH).toBe(500);
    const base = { type: "usage-batch" as const, schemaVersion: 1, agentVersion: "0.1.0" };
    expect(usageBatchMsgSchema.safeParse({ ...base, events: [] }).success).toBe(false);
    expect(usageBatchAckMsgSchema.safeParse({ type: "usage-batch-ack", ids: [] }).success).toBe(false);
  });

  it("matches only OpenAI inference endpoints (probes stay uncaptured)", () => {
    expect(CAPTURED_ENDPOINT_RE.test("/v1/chat/completions")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/completions")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/embeddings")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/responses")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/models")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/metrics")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/health")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/slots")).toBe(false);
  });
});
