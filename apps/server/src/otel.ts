/**
 * Env-gated OpenTelemetry export for the hub (IRI-039 / IR-116 + IR-117).
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, each HTTP request gets a SERVER
 * span (W3C trace context extracted from incoming headers, so an instrumented
 * client and — through the capture proxy — vLLM continue the same trace).
 * Deliberately manual middleware, not `@opentelemetry/sdk-node` +
 * instrumentation-express: the server is ESM and require-in-the-middle
 * patching is not reliable there; ~40 lines beat a loader dependency.
 *
 * `/healthz` is skipped (probe noise, ADR-0008 §2's "no rows for probes"
 * posture applied to spans); span names normalize id segments to keep
 * cardinality low. Fail-open: export problems never affect serving.
 */
import { context, defaultTextMapGetter, SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { Request, RequestHandler, Response } from "express";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { Writable } from "node:stream";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider, SimpleLogRecordProcessor, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";

/** W3C trace context extraction — explicit, not the (unset) global propagator. */
const TRACE_PROPAGATOR = new W3CTraceContextPropagator();

let tracer: Tracer | null = null;
let traceProvider: BasicTracerProvider | null = null;
let logProvider: LoggerProvider | null = null;

/** Flushes/shuts down the OTLP pipelines (call on SIGTERM so the last
 *  batching window is not lost on restarts/deployments). Never throws. */
export async function shutdownOtel(): Promise<void> {
  try {
    await logProvider?.shutdown();
  } catch { /* fail-open */ }
  logProvider = null;
  try {
    await traceProvider?.shutdown();
  } catch { /* fail-open */ }
  traceProvider = null;
  tracer = null;
}

export function otelEnabled(): boolean {
  return tracer !== null;
}

/** Test seam: drops the local provider/tracer so a test can re-init. */
export function resetOtelForTest(): void {
  tracer = null;
  traceProvider = null;
  logProvider = null;
}

function serviceName(defaultName: string): string {
  return process.env.OTEL_SERVICE_NAME?.trim() || defaultName;
}

export interface OtelInit {
  serviceName: string;
  version?: string;
  log?: (message: string) => void;
  /** Test seam: exporter replaces the OTLP one and spans flush synchronously. */
  exporter?: SpanExporter;
}

/**
 * Registers the trace pipeline. Returns whether export is active — false when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is unset or setup failed (never throws).
 */
export function initOtel(opts: OtelInit): boolean {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || tracer !== null) return tracer !== null;
  try {
    const name = serviceName(opts.serviceName);
    const resource = resourceFromAttributes({ "service.name": name, ...(opts.version ? { "service.version": opts.version } : {}) });
    const spanProcessors = [
      opts.exporter !== undefined ? new SimpleSpanProcessor(opts.exporter) : new BatchSpanProcessor(new OTLPTraceExporter()),
    ];
    const provider = new BasicTracerProvider({ resource, spanProcessors });
    traceProvider = provider;
    tracer = provider.getTracer("irori", opts.version);
    opts.log?.(`otel trace export enabled → ${endpoint} (service ${name})`);
    return true;
  } catch (err) {
    opts.log?.(`otel init failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Collapses UUID and numeric path segments so span names stay low-cardinality. */
export function normalizeRoute(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

/** The request-span middleware; mount before any route/parser middleware. */
export const otelRequestMiddleware: RequestHandler = (req: Request, res: Response, next): void => {
  if (tracer === null || req.path === "/healthz") return next();
  try {
    const headers: Record<string, string> = {};
    const tp = firstHeader(req.headers["traceparent"]);
    if (tp !== null) headers.traceparent = tp;
    const ts = firstHeader(req.headers["tracestate"]);
    if (ts !== null) headers.tracestate = ts;
    const parent = TRACE_PROPAGATOR.extract(context.active(), headers, defaultTextMapGetter);

    const attrs: Record<string, string | number> = {
      "http.request.method": req.method,
      "url.path": req.path,
      "url.scheme": "http",
      "server.address": req.hostname ?? "unknown",
      "server.port": req.socket.localPort ?? 0,
    };
    const span = tracer.startSpan(`${req.method} ${normalizeRoute(req.path)}`, { kind: SpanKind.SERVER, attributes: attrs }, parent);
    res.on("close", () => {
      try {
        span.setAttribute("http.response.status_code", res.statusCode);
        if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
        span.end();
      } catch {
        // Fail-open (IR-116): end-of-span bookkeeping never throws into res.
      }
    });
  } catch {
    // Fail-open: no span is worse than a broken response, never the reverse.
  }
  next();
};

/* ── Logs (IR-117) — mirrors apps/agent/src/otel.ts ──────────────────────── */

const PINO_LEVEL_TO_SEVERITY: Record<number, { n: SeverityNumber; text: string }> = {
  10: { n: SeverityNumber.TRACE, text: "TRACE" },
  20: { n: SeverityNumber.DEBUG, text: "DEBUG" },
  30: { n: SeverityNumber.INFO, text: "INFO" },
  40: { n: SeverityNumber.WARN, text: "WARN" },
  50: { n: SeverityNumber.ERROR, text: "ERROR" },
  60: { n: SeverityNumber.FATAL, text: "FATAL" },
};

/** Pino destination bridging JSON lines to OTLP logs; null when disabled. */
export function otelLogBridge(opts: { serviceName: string; version?: string; exporter?: LogRecordExporter }): Writable | null {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  try {
    const resource = resourceFromAttributes({ "service.name": serviceName(opts.serviceName), ...(opts.version ? { "service.version": opts.version } : {}) });
    const processors = [
      opts.exporter !== undefined ? new SimpleLogRecordProcessor({ exporter: opts.exporter }) : new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
    ];
    const provider = new LoggerProvider({ resource, processors });
    logProvider = provider;
    const logger = provider.getLogger("irori", opts.version);
    return new Writable({
      write(chunk: Buffer, _enc, cb): void {
        try {
          const line = JSON.parse(chunk.toString("utf8")) as { level?: number; msg?: string; time?: number } & Record<string, unknown>;
          const sev = PINO_LEVEL_TO_SEVERITY[line.level ?? 30] ?? PINO_LEVEL_TO_SEVERITY[30]!;
          const { level: _l, msg: _m, time: _t, ...rest } = line;
          logger.emit({
            severityNumber: sev.n,
            severityText: sev.text,
            body: line.msg ?? "",
            observedTimestamp: line.time ?? Date.now(),
            attributes: rest,
          });
        } catch {
          // A line that isn't ours is dropped, never thrown into pino.
        }
        cb();
      },
    });
  } catch {
    return null;
  }
}
