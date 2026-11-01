import { describe, expect, it } from "vitest";
import {
  CAPTURED_ENDPOINT_RE,
  IRORI_AGENT_TYPE_HEADER,
  IRORI_CLIENT_HEADER,
  IRORI_PROJECT_HEADER,
  MAX_USAGE_BATCH,
  iroriIdentityFromHeaders,
  normalizeErrorSignature,
  normalizeUsageEndpoint,
  parseIroriRetryHeader,
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

  it("matches OpenAI inference endpoints with or without the /v1 prefix (IR-154)", () => {
    expect(CAPTURED_ENDPOINT_RE.test("/v1/chat/completions")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/completions")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/embeddings")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/responses")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/chat/completions")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/completions")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/embeddings")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/responses")).toBe(true);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/models")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/models")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/metrics")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/health")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/slots")).toBe(false);
    // Only the exact endpoint suffix matches — path traversal/nesting no.
    expect(CAPTURED_ENDPOINT_RE.test("/api/chat/completions")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/v2/chat/completions")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("/v1/chat/completions/extra")).toBe(false);
    expect(CAPTURED_ENDPOINT_RE.test("v1/chat/completions")).toBe(false);
  });

  it("canonicalizes captured endpoints to the /v1 spelling (IR-154)", () => {
    expect(normalizeUsageEndpoint("/chat/completions")).toBe("/v1/chat/completions");
    expect(normalizeUsageEndpoint("/completions")).toBe("/v1/completions");
    expect(normalizeUsageEndpoint("/embeddings")).toBe("/v1/embeddings");
    expect(normalizeUsageEndpoint("/responses")).toBe("/v1/responses");
    expect(normalizeUsageEndpoint("/v1/chat/completions")).toBe("/v1/chat/completions");
    // Non-captured paths pass through untouched.
    expect(normalizeUsageEndpoint("/health")).toBe("/health");
    expect(normalizeUsageEndpoint("/")).toBe("/");
  });

  it("parses X-Irori-* identity headers with bounds (IR-55)", () => {
    const full = iroriIdentityFromHeaders({
      [IRORI_PROJECT_HEADER]: "  irori  ",
      [IRORI_AGENT_TYPE_HEADER]: "subagent",
      [IRORI_CLIENT_HEADER]: "omp",
    });
    expect(full).toEqual({ clientName: "omp", clientProject: "irori", clientAgentType: "subagent" });
    // Invalid agent type and over-length values fall back to null, never throw.
    const bad = iroriIdentityFromHeaders({
      [IRORI_AGENT_TYPE_HEADER]: "rootkit",
      [IRORI_CLIENT_HEADER]: "x".repeat(500),
      [IRORI_PROJECT_HEADER]: "",
    });
    expect(bad).toEqual({ clientName: null, clientProject: null, clientAgentType: null });
    expect(iroriIdentityFromHeaders({})).toEqual({ clientName: null, clientProject: null, clientAgentType: null });
    expect(iroriIdentityFromHeaders({ [IRORI_PROJECT_HEADER]: ["a", "b"] }).clientProject).toBe("a");
  });

  it("parses the X-Irori-Retry contract (IR-55)", () => {
    expect(parseIroriRetryHeader("attempt=3;kind=auto-retry;status=recovered;superseded-by=resp_9")).toEqual({
      attempt: 3,
      kind: "auto-retry",
      status: "recovered",
      supersededBy: "resp_9",
    });
    expect(parseIroriRetryHeader("attempt=2")).toEqual({ attempt: 2, kind: null, status: null, supersededBy: null });
    expect(parseIroriRetryHeader("junk;;attempt=nope")).toEqual({ attempt: null, kind: null, status: null, supersededBy: null });
    expect(parseIroriRetryHeader(undefined)).toEqual({ attempt: null, kind: null, status: null, supersededBy: null });
    expect(parseIroriRetryHeader("a=1".repeat(400)).attempt).toBeNull(); // over-length header ignored
  });

  it("carries client identity fields on the ingest event", () => {
    const parsed = usageRequestSchema.parse({
      id: "00000000-0000-4000-8000-000000000003",
      ts: 1,
      port: 8081,
      endpoint: "/v1/chat/completions",
      reqBytes: 0,
      resBytes: 0,
      clientName: "omp",
      clientProject: "irori",
      clientAgentType: "main",
      clientKeyHash: "a".repeat(64),
      retryAttempt: 1,
      retryKind: "auto-retry",
      retryStatus: "recovered",
      retrySupersededBy: "resp_1",
    });
    expect(parsed.clientAgentType).toBe("main");
    expect(() =>
      usageRequestSchema.parse({
        id: "00000000-0000-4000-8000-000000000004",
        ts: 1,
        port: 8081,
        endpoint: "/v1/chat/completions",
        reqBytes: 0,
        resBytes: 0,
        clientAgentType: "intruder",
      }),
    ).toThrow();
    expect(() =>
      usageRequestSchema.parse({
        id: "00000000-0000-4000-8000-000000000005",
        ts: 1,
        port: 8081,
        endpoint: "/v1/chat/completions",
        reqBytes: 0,
        resBytes: 0,
        clientKeyHash: "not-a-hash",
      }),
    ).toThrow();
  });
});
