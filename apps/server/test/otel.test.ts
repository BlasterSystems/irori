import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { initOtel, normalizeRoute, otelEnabled, otelRequestMiddleware, resetOtelForTest } from "../src/otel.js";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function fakeReq(method: string, path: string, headers: Record<string, string> = {}): Request {
  return { method, path, headers, hostname: "hub.test", socket: { localPort: 3947 } } as unknown as Request;
}

function fakeRes(statusCode = 200): Response & EventEmitter {
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  (res as { statusCode: number }).statusCode = statusCode;
  return res;
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

describe("server otel (IR-116)", () => {
  it("normalizes id segments for low-cardinality span names", () => {
    expect(normalizeRoute("/api/v1/usage/requests")).toBe("/api/v1/usage/requests");
    expect(normalizeRoute("/api/v1/usage/requests/0b8fdf3e-9d0c-4a5f-8f1e-3d1a2b6c7d8e")).toBe("/api/v1/usage/requests/:id");
    expect(normalizeRoute("/api/v1/nodes/42/jobs")).toBe("/api/v1/nodes/:id/jobs");
    expect(normalizeRoute("/api/v1/benches/12/attempts/3")).toBe("/api/v1/benches/:id/attempts/:id");
  });

  it("is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    expect(initOtel({ serviceName: "irori-server" })).toBe(false);
    expect(otelEnabled()).toBe(false);
    let called = false;
    otelRequestMiddleware(fakeReq("GET", "/api/v1/nodes"), fakeRes(), () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("creates a SERVER span per request, skipping /healthz, parented by traceparent", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const exporter = new InMemorySpanExporter();
    initOtel({ serviceName: "irori-server", version: "0.3.0", exporter });

    let called = false;
    const req = fakeReq("GET", "/api/v1/usage/overview", { traceparent: TP, tracestate: "irori-test=1" });
    const res = fakeRes(200);
    otelRequestMiddleware(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    // Span ends with the response, not with next().
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    const healthRes = fakeRes();
    otelRequestMiddleware(fakeReq("GET", "/healthz"), healthRes, () => {});
    healthRes.emit("close");
    expect(exporter.getFinishedSpans()).toHaveLength(0); // healthz skipped

    res.emit("close");
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("GET /api/v1/usage/overview");
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.parentSpanContext?.spanId).toBe("00f067aa0ba902b7");
    expect(span.attributes["http.request.method"]).toBe("GET");
    expect(span.attributes["url.path"]).toBe("/api/v1/usage/overview");
    expect(span.attributes["http.response.status_code"]).toBe(200);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("marks 5xx responses as ERROR", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    const exporter = new InMemorySpanExporter();
    initOtel({ serviceName: "irori-server", exporter });
    const res = fakeRes(503);
    otelRequestMiddleware(fakeReq("GET", "/api/v1/nodes"), res, () => {});
    res.emit("close");
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["http.response.status_code"]).toBe(503);
  });
});
