import { randomUUID } from "node:crypto";
import { CAPTURED_ENDPOINT_RE, normalizeErrorSignature, usageRequestSchema, type UsageRequest } from "@irori/core";

/**
 * Passive capture state (ADR-0008): observes a request/response pair and
 * produces one `UsageRequest`. Every function here is pure w.r.t. the
 * forwarding path — callers tee bytes in, nothing can throw out.
 */

/** OpenAI-compat detection: a body that parses and carries any of these keys. */
const OPENAI_BODY_KEYS = ["model", "messages", "prompt", "input"] as const;

/** Bounded SSE line re-assembly: bigger lines are treated as unparseable. */
const MAX_SSE_LINE_BYTES = 1024 * 1024;

export interface CaptureInit {
  setupId: string | null;
  port: number;
  endpoint: string;
  sourceAddr: string | null;
}

export interface CaptureFinish {
  status: number | null;
  resBytes: number;
  /** Terminal error (client abort, upstream failure); null when ok. */
  error: string | null;
}

export class Capture {
  readonly id: string;
  readonly startedAtMs: number;
  private readonly init: CaptureInit;
  private model: string | null = null;
  private stream = false;
  private captured = false;
  /** True once the body crossed the parse cap (sizes still counted). */
  private reqParseOverflow = false;
  private reqJson: unknown;
  private reqBytes = 0;
  private resBytes = 0;
  private status: number | null = null;
  private error: string | null = null;
  private ttftMs: number | null = null;
  private firstDeltaAtMs: number | null = null;
  private lastDeltaAtMs: number | null = null;
  private finishReason: string | null = null;
  private usage: Record<string, unknown> | null = null;
  private engineMeta: Record<string, unknown> | null = null;
  private sseLine: Buffer = Buffer.alloc(0);
  private sseOverflow = false;

  constructor(init: CaptureInit) {
    this.init = init;
    this.id = randomUUID();
    this.startedAtMs = Date.now();
  }

  get endpoint(): string {
    return this.init.endpoint;
  }

  /** Inference endpoints with parseable OpenAI bodies are captured (ADR-0008 §2). */
  static wanted(method: string, url: string | undefined): boolean {
    return (
      method === "POST" &&
      url !== undefined &&
      CAPTURED_ENDPOINT_RE.test(url.split("?")[0] ?? "")
    );
  }

  /** Accumulates the request body; returns it so the proxy can forward. */
  observeRequestBody(chunk: Buffer): void {
    this.reqBytes += chunk.length;
    if (this.reqParseOverflow) return;
    if (this.reqBytes > MAX_BODY_PARSE_BYTES) {
      this.reqParseOverflow = true;
      return;
    }
    // Parse once complete; accumulate raw until then.
    this.pendingBody = this.pendingBody === null ? chunk : Buffer.concat([this.pendingBody, chunk]);
  }

  private pendingBody: Buffer | null = null;

  /** Request fully received — parse the OpenAI body best-effort. */
  observeRequestEnd(): void {
    if (this.reqParseOverflow || this.pendingBody === null) return;
    try {
      const parsed: unknown = JSON.parse(this.pendingBody.toString("utf8"));
      if (parsed === null || typeof parsed !== "object") return;
      const obj = parsed as Record<string, unknown>;
      if (!OPENAI_BODY_KEYS.some((k) => k in obj)) return;
      this.captured = true;
      this.reqJson = obj;
      if (typeof obj.model === "string" && obj.model.length > 0) this.model = obj.model;
      this.stream = obj.stream === true;
    } catch {
      // Not JSON → not captured; forwarding is unaffected.
    } finally {
      this.pendingBody = null;
    }
  }

  get isCaptured(): boolean {
    return this.captured;
  }

  /** Tee one response chunk (also used for size counting on skipped requests). */
  observeResponseChunk(chunk: Buffer, atMs: number): void {
    this.resBytes += chunk.length;
    if (!this.captured) return;
    if (this.stream) this.observeSseChunk(chunk, atMs);
    else this.observeJsonChunk(chunk);
  }

  private observeSseChunk(chunk: Buffer, atMs: number): void {
    this.sseLine = this.sseLine.length === 0 ? chunk : Buffer.concat([this.sseLine, chunk]);
    if (this.sseLine.length > MAX_SSE_LINE_BYTES) {
      this.sseOverflow = true;
      this.sseLine = Buffer.alloc(0);
    }
    let idx: number;
    while (!this.sseOverflow && (idx = this.sseLine.indexOf(0x0a)) !== -1) {
      const line = this.sseLine.subarray(0, idx).toString("utf8").replace(/\r$/, "");
      this.sseLine = this.sseLine.subarray(idx + 1);
      this.observeSseLine(line, atMs);
    }
  }

  private observeSseLine(line: string, atMs: number): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    this.observeUsageish(obj, atMs);
  }

  private observeUsageish(obj: Record<string, unknown>, atMs: number): void {
    if (this.engineMeta === null && obj.tensorfold !== null && typeof obj.tensorfold === "object") {
      this.engineMeta = obj.tensorfold as Record<string, unknown>;
    }
    if (obj.usage !== null && typeof obj.usage === "object") {
      this.usage = obj.usage as Record<string, unknown>;
    }
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    for (const choice of choices) {
      if (choice === null || typeof choice !== "object") continue;
      const c = choice as Record<string, unknown>;
      if (typeof c.finish_reason === "string") this.finishReason = c.finish_reason;
      if (c.delta !== null && typeof c.delta === "object") {
        const delta = c.delta as Record<string, unknown>;
        const hasContent =
          (typeof delta.content === "string" && delta.content.length > 0) ||
          (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) ||
          Array.isArray(delta.tool_calls);
        if (hasContent) {
          if (this.firstDeltaAtMs === null) {
            this.firstDeltaAtMs = atMs;
            this.ttftMs = Math.max(0, Math.round(atMs - this.startedAtMs));
          }
          this.lastDeltaAtMs = atMs;
        }
      }
    }
  }

  private jsonBuf: Buffer = Buffer.alloc(0);

  private observeJsonChunk(chunk: Buffer): void {
    // Non-streaming: keep a bounded copy of the head for one parse at the end.
    if (this.jsonBuf.length < MAX_RESPONSE_PARSE_BYTES) {
      const room = MAX_RESPONSE_PARSE_BYTES - this.jsonBuf.length;
      this.jsonBuf = Buffer.concat([this.jsonBuf, chunk.subarray(0, Math.min(room, chunk.length))]);
    }
  }

  observeResponseStart(status: number): void {
    this.status = status;
  }

  /** Mark terminal failure without a response (refused upstream, abort). */
  observeError(message: string): void {
    if (this.error === null) this.error = message.slice(0, 2000);
  }

  /** Non-2xx: try to lift `error.message` from a bounded JSON error body. */
  observeErrorBody(body: Buffer): void {
    if (this.status === null || this.status < 400) return;
    try {
      const parsed: unknown = JSON.parse(body.subarray(0, 16_384).toString("utf8"));
      const message =
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).error !== null &&
        typeof (parsed as Record<string, unknown>).error === "object"
          ? (parsed as { error: { message?: unknown } }).error.message
          : undefined;
      if (typeof message === "string" && message.length > 0) {
        this.error = message.slice(0, 2000);
      }
    } catch {
      // Non-JSON error body → status alone.
    }
  }

  /** Terminal: produce the event, or null when not captured. */
  finish(): UsageRequest | null {
    // An upstream error can arrive before the request body finished — parse
    // whatever arrived so the event is still emitted (idempotent).
    this.observeRequestEnd();
    if (!this.captured) return null;
    if (!this.stream && this.jsonBuf.length > 0) {
      try {
        const parsed: unknown = JSON.parse(this.jsonBuf.toString("utf8"));
        if (parsed !== null && typeof parsed === "object") {
          this.observeUsageish(parsed as Record<string, unknown>, Date.now());
        }
      } catch {
        // Non-JSON body → sizes/status still recorded.
      }
      this.jsonBuf = Buffer.alloc(0);
    }
    const durationMs = Math.max(0, Date.now() - this.startedAtMs);
    const usage = this.usage;
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
    let decodeTps: number | null = null;
    if (this.firstDeltaAtMs !== null && this.lastDeltaAtMs !== null && this.lastDeltaAtMs > this.firstDeltaAtMs) {
      const completion = num(usage?.completion_tokens);
      const seconds = (this.lastDeltaAtMs - this.firstDeltaAtMs) / 1000;
      if (completion !== null && seconds > 0) decodeTps = completion / seconds;
    }
    const promptDetails =
      usage?.prompt_tokens_details !== null && typeof usage?.prompt_tokens_details === "object"
        ? (usage?.prompt_tokens_details as Record<string, unknown>)
        : undefined;
    const completionDetails =
      usage?.completion_tokens_details !== null && typeof usage?.completion_tokens_details === "object"
        ? (usage?.completion_tokens_details as Record<string, unknown>)
        : undefined;
    const request: UsageRequest = {
      id: this.id,
      ts: this.startedAtMs,
      setupId: this.init.setupId,
      port: this.init.port,
      model: this.model,
      endpoint: this.init.endpoint,
      stream: this.stream,
      status: this.status,
      finishReason: this.finishReason,
      error: this.error,
      errorSig: this.error === null ? null : normalizeErrorSignature(this.error),
      durationMs,
      ttftMs: this.ttftMs,
      decodeTps: decodeTps === null ? null : Math.round(decodeTps * 100) / 100,
      promptTokens: num(usage?.prompt_tokens),
      completionTokens: num(usage?.completion_tokens),
      cachedTokens: num(promptDetails?.cached_tokens),
      reasoningTokens: num(completionDetails?.reasoning_tokens),
      totalTokens: num(usage?.total_tokens),
      engineMeta: this.engineMeta,
      reqBytes: this.reqBytes,
      resBytes: this.resBytes,
      sourceAddr: this.init.sourceAddr,
    };
    // Capture must never produce an invalid event — drop, don't throw.
    const parsed = usageRequestSchema.safeParse(request);
    return parsed.success ? parsed.data : null;
  }
}

/** Request bodies above this are forwarded but not parsed (sizes still counted). */
export const MAX_BODY_PARSE_BYTES = 64 * 1024 * 1024;
/** Non-streaming response head kept for the single end-parse. */
export const MAX_RESPONSE_PARSE_BYTES = 4 * 1024 * 1024;
