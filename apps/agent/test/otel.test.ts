import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { usageRequestSchema, type UsageRequest } from "@irori/core";
import { emitUsageSpan, initOtel, otelEnabled, otelLogBridge, resetOtelForTest } from "../src/otel.js";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function fixture(overrides: Record<string, unknown> = {}): UsageRequest {
  return usageRequestSchema.parse({
    id: randomUUID(),
    ts: 1_700_000_000_000,
    setupId: "11111111-1111-4111-8111-111111111111",
    port: 8081,
    model: "GLM-5.3-Flash-EXL3",
    endpoint: "/v1/chat/completions",
    stream: true,
    status: 200,
    finishReason: "stop",
    error: null,
    durationMs: 1200,
    ttftMs: 23,
    promptTokens: 1221,
    completionTokens: 4,
    cachedTokens: 7,
    reasoningTokens: 4,
    totalTokens: 1225,
    reqBytes: 100,
    resBytes: 200,
    sourceAddr: "127.0.0.1",
    traceparent: TP,
    tracestate: "irori-test=1",
    ...overrides,
  });
}

beforeEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SERVICE_NAME;
  resetOtelForTest();
});

afterEach(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  resetOtelForTest();
});

describe("otel export (IR-116/IR-117)", () => {
  it("is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    expect(initOtel({ serviceName: "irori-agent" })).toBe(false);
    expect(otelEnabled()).toBe(false);
    expect(() => emitUsageSpan(fixture())).not.toThrow();
    expect(otelLogBridge({ serviceName: "irori-agent" })).toBeNull();
  });

  it("exports one GenAI span per captured request, parented by the client trace", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const exporter = new InMemorySpanExporter();
    expect(initOtel({ serviceName: "irori-agent", version: "0.3.0", exporter })).toBe(true);

    emitUsageSpan(fixture());
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("chat GLM-5.3-Flash-EXL3");
    expect(span.kind).toBe(SpanKind.CLIENT);
    // W3C traceparent → the proxy span nests under the client's span.
    expect(span.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(span.startTime[0]).toBe(1_700_000_000);
    expect(span.endTime[0]).toBe(1_700_000_001);
    const a = span.attributes;
    expect(a["gen_ai.operation.name"]).toBe("chat");
    expect(a["gen_ai.request.model"]).toBe("GLM-5.3-Flash-EXL3");
    expect(a["gen_ai.request.stream"]).toBe(true);
    expect(a["gen_ai.usage.input_tokens"]).toBe(1221);
    expect(a["gen_ai.usage.output_tokens"]).toBe(4);
    expect(a["gen_ai.usage.cache_read.input_tokens"]).toBe(7);
    expect(a["gen_ai.usage.reasoning.output_tokens"]).toBe(4);
    expect(a["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(a["gen_ai.response.time_to_first_chunk"]).toBe(0.023);
    expect(a["http.response.status_code"]).toBe(200);
    expect(a["irori.setup_id"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("maps non-chat endpoints and flags errors as ERROR status", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const exporter = new InMemorySpanExporter();
    initOtel({ serviceName: "irori-agent", exporter });

    emitUsageSpan(fixture({ endpoint: "/v1/completions", model: "m", error: "upstream unreachable: ECONNREFUSED", status: null, traceparent: null, tracestate: null }));
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.name).toBe("text_completion m");
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("ECONNREFUSED");
  });

  it("never throws on malformed trace context (fail-open)", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    initOtel({ serviceName: "irori-agent", exporter: new InMemorySpanExporter() });
    expect(() => emitUsageSpan(fixture({ traceparent: "garbage", tracestate: undefined }))).not.toThrow();
  });

  it("bridges pino JSON lines into OTLP logs with pino severity mapping", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const exporter = new InMemoryLogRecordExporter();
    const bridge = otelLogBridge({ serviceName: "irori-agent", version: "0.3.0", exporter });
    expect(bridge).not.toBeNull();
    await new Promise<void>((resolve) => {
      bridge!.write(JSON.stringify({ level: 50, msg: "boom", time: 1_700_000_000_000, service: "irori-agent", pid: 1 }), () => resolve());
    });
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.body).toBe("boom");
    expect(rec.severityNumber).toBe(SeverityNumber.ERROR);
    expect(rec.severityText).toBe("ERROR");
    expect(rec.attributes?.service).toBe("irori-agent");
  });
});
