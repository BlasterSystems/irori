/**
 * Env-gated OpenTelemetry export (IRI-039 / IR-116 + IR-117).
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the agent exports one GenAI span
 * per captured request (mapped from the fields the capture proxy already
 * parsed — no second parse) and bridges pino log records to OTLP logs. Unset,
 * nothing is created and `emitUsageSpan`/`otelLogBridge` are no-ops.
 *
 * Fail-open everywhere (ADR-0008 posture): export problems must never affect
 * capture, the proxy path, or the agent. The W3C trace context rides on the
 * usage event (`traceparent`/`tracestate`, see `packages/core/src/usage.ts`),
 * so the exported span parents the client's span and — because the proxy
 * forwards the headers verbatim and vLLM continues traces natively —
 * client → proxy → engine renders as one trace in any OTLP backend.
 *
 * Deliberately no `trace.setGlobalTracerProvider`: the tracer comes from the
 * locally-created provider, keeping test/instance state self-contained.
 */
import { Writable } from "node:stream";
import { context, defaultTextMapGetter, SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { BatchLogRecordProcessor, LoggerProvider, SimpleLogRecordProcessor, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { UsageRequest } from "@irori/core";

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
  /** Default `service.name` when `OTEL_SERVICE_NAME` is unset. */
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
    const resource = resourceFromAttributes({ "service.name": serviceName(opts.serviceName), ...(opts.version ? { "service.version": opts.version } : {}) });
    const spanProcessors = [
      opts.exporter !== undefined ? new SimpleSpanProcessor(opts.exporter) : new BatchSpanProcessor(new OTLPTraceExporter()),
    ];
    const provider = new BasicTracerProvider({ resource, spanProcessors });
    traceProvider = provider;
    tracer = provider.getTracer("irori", opts.version);
    opts.log?.(`otel trace export enabled → ${endpoint} (service ${serviceName(opts.serviceName)})`);
    return true;
  } catch (err) {
    opts.log?.(`otel init failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Endpoint path → `gen_ai.operation.name` (semconv well-known values). */
const OPERATION_BY_ENDPOINT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/v1\/chat\/completions$/, "chat"],
  [/^\/v1\/completions$/, "text_completion"],
  [/^\/v1\/embeddings$/, "embeddings"],
  [/^\/v1\/responses$/, "generate_content"],
];

/**
 * Exports one GenAI span for a captured request. All data comes from the
 * record the proxy already produced; when `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * unset this is a no-op. Never throws.
 */
export function emitUsageSpan(record: UsageRequest): void {
  if (tracer === null) return;
  try {
    const op = OPERATION_BY_ENDPOINT.find(([re]) => re.test(record.endpoint))?.[1] ?? "chat";
    let parent = context.active();
    if (record.traceparent != null) {
      const headers: Record<string, string> = { traceparent: record.traceparent };
      if (record.tracestate != null) headers.tracestate = record.tracestate;
      parent = TRACE_PROPAGATOR.extract(parent, headers, defaultTextMapGetter);
    }
    const attrs: Record<string, string | number | boolean | string[]> = {
      "gen_ai.operation.name": op,
      "gen_ai.request.stream": record.stream,
      "url.path": record.endpoint,
      "irori.request_id": record.id,
    };
    if (record.model !== null) attrs["gen_ai.request.model"] = record.model;
    if (record.promptTokens !== null) attrs["gen_ai.usage.input_tokens"] = record.promptTokens;
    if (record.completionTokens !== null) attrs["gen_ai.usage.output_tokens"] = record.completionTokens;
    if (record.cachedTokens !== null) attrs["gen_ai.usage.cache_read.input_tokens"] = record.cachedTokens;
    if (record.reasoningTokens !== null) attrs["gen_ai.usage.reasoning.output_tokens"] = record.reasoningTokens;
    if (record.finishReason !== null) attrs["gen_ai.response.finish_reasons"] = [record.finishReason];
    if (record.ttftMs !== null) attrs["gen_ai.response.time_to_first_chunk"] = record.ttftMs / 1000;
    if (record.status !== null) attrs["http.response.status_code"] = record.status;
    if (record.setupId !== null) attrs["irori.setup_id"] = record.setupId;
    if (record.sourceAddr !== null) attrs["irori.source_addr"] = record.sourceAddr;

    const span = tracer.startSpan(
      `${op} ${record.model ?? "unknown"}`,
      { kind: SpanKind.CLIENT, attributes: attrs, startTime: record.ts },
      parent,
    );
    if (record.error !== null) span.setStatus({ code: SpanStatusCode.ERROR, message: record.error });
    else if (record.status !== null && record.status >= 400)
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${record.status}` });
    span.end(record.ts + (record.durationMs ?? 0));
  } catch {
    // Fail-open (IR-116): an export problem never affects capture.
  }
}

/* ── Logs (IR-117) ───────────────────────────────────────────────────────── */

/** pino level number → OTLP severity (spec: 1-24, INFO=9, WARN=13, ERROR=17, FATAL=21). */
const PINO_LEVEL_TO_SEVERITY: Record<number, { n: SeverityNumber; text: string }> = {
  10: { n: SeverityNumber.TRACE, text: "TRACE" },
  20: { n: SeverityNumber.DEBUG, text: "DEBUG" },
  30: { n: SeverityNumber.INFO, text: "INFO" },
  40: { n: SeverityNumber.WARN, text: "WARN" },
  50: { n: SeverityNumber.ERROR, text: "ERROR" },
  60: { n: SeverityNumber.FATAL, text: "FATAL" },
};

/**
 * A pino destination that forwards each JSON line into an OTLP logs pipeline.
 * Returns null when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (stdout only) —
 * the caller then just skips the extra stream. Never throws.
 */
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
