import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  CAPTURED_ENDPOINT_RE,
  bearerKeyHash,
  normalizeErrorSignature,
  parseIroriRetryHeader,
  usageRequestSchema,
  type BodyRetention,
  type ClientIdentityFields,
  type RetryLineage,
  type UsagePartWire,
  type UsageRequest,
} from "@irori/core";

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
  /** IR-52 body retention: null = off (no body bytes stored). */
  retention: BodyRetention | null;
  /** IR-55: header-declared client identity (client-asserted, bounded). */
  identity: ClientIdentityFields;
  /** IR-55: sha256 hex of the presented bearer token; null when absent. */
  keyHash: string | null;
  /** IR-55: parsed X-Irori-Retry lineage; null fields when not reported. */
  retry: RetryLineage;
}

/** Parts stored per request are folded into a marker past this (schema cap is 8192). */
const MAX_PARTS_PER_REQUEST = 8192;

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
  /** IR-52 response assembly: streamed deltas and non-streaming messages unify. */
  private contentText = "";
  private reasoningText = "";
  private readonly toolCalls = new Map<number, { id: string | null; name: string; args: string }>();
  /** Bounded raw error body (≤16 KiB) for the `error` part when retention is on. */
  private errorBodyRaw: string | null = null;

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
      // Streaming deltas and the non-streaming `message` share one shape for
      // content/reasoning/tool_calls — assemble both into the response part.
      const piece = c.delta !== null && typeof c.delta === "object"
        ? (c.delta as Record<string, unknown>)
        : c.message !== null && typeof c.message === "object"
          ? (c.message as Record<string, unknown>)
          : null;
      if (piece === null) continue;
      if (typeof piece.content === "string") this.contentText += piece.content;
      if (typeof piece.reasoning_content === "string") this.reasoningText += piece.reasoning_content;
      if (Array.isArray(piece.tool_calls)) this.observeToolCallFragments(piece.tool_calls);
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

  /** Reassembles streamed `tool_calls` fragments by index (name/args concat). */
  private observeToolCallFragments(fragments: unknown[]): void {
    for (const fragment of fragments) {
      if (fragment === null || typeof fragment !== "object") continue;
      const f = fragment as Record<string, unknown>;
      const index = typeof f.index === "number" && Number.isInteger(f.index) && f.index >= 0 ? f.index : 0;
      let entry = this.toolCalls.get(index);
      if (entry === undefined) {
        entry = { id: null, name: "", args: "" };
        this.toolCalls.set(index, entry);
      }
      if (typeof f.id === "string" && f.id.length > 0 && entry.id === null) entry.id = f.id;
      const fn = f.function !== null && typeof f.function === "object"
        ? (f.function as Record<string, unknown>)
        : null;
      if (fn !== null) {
        if (typeof fn.name === "string") entry.name += fn.name;
        if (typeof fn.arguments === "string") entry.args += fn.arguments;
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

  /** Non-2xx: keep a bounded copy of the error body and lift `error.message`. */
  observeErrorBody(body: Buffer): void {
    if (this.status === null || this.status < 400) return;
    const bounded = body.subarray(0, 16_384);
    if (this.errorBodyRaw === null) this.errorBodyRaw = bounded.toString("utf8");
    try {
      const parsed: unknown = JSON.parse(bounded.toString("utf8"));
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
      parts: this.buildParts(),
      clientName: this.init.identity.clientName,
      clientProject: this.init.identity.clientProject,
      clientAgentType: this.init.identity.clientAgentType,
      clientKeyHash: this.init.keyHash,
      retryAttempt: this.init.retry.attempt,
      retryKind: this.init.retry.kind,
      retryStatus: this.init.retry.status,
      retrySupersededBy: this.init.retry.supersededBy,
    };
    // Capture must never produce an invalid event — drop, don't throw. A
    // parts problem must not cost the native fields either: retry without
    // them (retention is best-effort by contract).
    let parsed = usageRequestSchema.safeParse(request);
    if (!parsed.success && request.parts.length > 0) {
      parsed = usageRequestSchema.safeParse({ ...request, parts: [] });
    }
    return parsed.success ? parsed.data : null;
  }

  /**
   * IR-52 body decomposition: canonical JSON per message/prompt/input, the
   * assembled assistant response, the error body, plus a marker when the
   * body cap omitted messages. Best-effort — any failure returns what was
   * built so far (never loses the native event).
   */
  private buildParts(): UsagePartWire[] {
    const retention = this.init.retention;
    if (retention === null || !this.captured) return [];
    try {
      const parts: UsagePartWire[] = [];
      const partCap = retention.partCapBytes;
      let storedBytes = 0;
      // Hashes/gzips one canonical value; partCap cuts oversize content into a
      // UTF-8-safe JSON wrapper so stored bytes always parse.
      const encode = (kind: UsagePartWire["kind"], role: string | null, value: unknown, maxBytes: number, originalBytes: number): boolean => {
        if (parts.length >= MAX_PARTS_PER_REQUEST) return false;
        let content = Buffer.from(JSON.stringify(value), "utf8");
        let truncated = false;
        const cap = Math.min(partCap, Math.max(1, maxBytes));
        if (content.length > cap) {
          truncated = true;
          const text = content.toString("utf8");
          // Binary-search the longest UTF-8-safe prefix that fits the cap —
          // the loop must be O(log n) on the agent's main loop (ADR-0010 §4).
          let lo = 0;
          let hi = text.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi + 1) / 2);
            if (Buffer.byteLength(text.slice(0, mid), "utf8") <= cap) lo = mid;
            else hi = mid - 1;
          }
          content = Buffer.from(
            JSON.stringify({ irori_truncated: true, original_bytes: content.length, prefix: text.slice(0, lo) }),
            "utf8",
          );
        }
        parts.push({
          hash: createHash("sha256").update(content).digest("hex"),
          kind,
          role,
          index: parts.length,
          bytes: originalBytes,
          gz: gzipSync(content).toString("base64"),
          truncated,
        });
        return true;
      };

      const obj = this.reqJson as Record<string, unknown> | null;
      const messages = obj !== null && Array.isArray(obj.messages) ? obj.messages : null;
      // Omissions are marked IN POSITION (ordinal fidelity for reconstruction):
      // a marker is emitted where consecutive messages were dropped, so the
      // reader sees exactly where stored content resumes.
      let pendingOmitted = 0;
      let pendingOmittedBytes = 0;
      const flushOmissions = (): void => {
        if (pendingOmitted === 0) return;
        const stored = encode(
          "marker",
          null,
          { irori_body_truncated: true, omitted_messages: pendingOmitted, omitted_bytes: pendingOmittedBytes },
          partCap,
          0,
        );
        if (!stored) return; // part limit reached — the tail marker carries the count
        pendingOmitted = 0;
        pendingOmittedBytes = 0;
      };
      if (messages !== null) {
        for (const message of messages) {
          if (message === null || typeof message !== "object") continue;
          const canonical = Buffer.from(JSON.stringify(message), "utf8");
          if (storedBytes + canonical.length > retention.bodyCapBytes) {
            pendingOmitted += 1;
            pendingOmittedBytes += canonical.length;
            continue;
          }
          flushOmissions();
          storedBytes += canonical.length;
          const roleValue = (message as Record<string, unknown>).role;
          const role = typeof roleValue === "string" && roleValue.length > 0 && roleValue.length <= 40 ? roleValue : null;
          encode("message", role, message, retention.bodyCapBytes - storedBytes + canonical.length, canonical.length);
        }
      } else if (obj !== null && "prompt" in obj) {
        encode("prompt", null, obj.prompt, retention.bodyCapBytes, Buffer.byteLength(JSON.stringify(obj.prompt ?? null)));
      } else if (obj !== null && "input" in obj) {
        encode("input", null, obj.input, retention.bodyCapBytes, Buffer.byteLength(JSON.stringify(obj.input ?? null)));
      }
      flushOmissions(); // trailing omissions (nothing stored after them)
      // Response part: the assembled assistant message (streamed deltas or the
      // non-streaming `message` object) — the final turn of the conversation.
      if (this.contentText !== "" || this.reasoningText !== "" || this.toolCalls.size > 0) {
        const assembled: Record<string, unknown> = { role: "assistant", content: this.contentText };
        if (this.reasoningText !== "") assembled.reasoning_content = this.reasoningText;
        if (this.toolCalls.size > 0) {
          assembled.tool_calls = [...this.toolCalls.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, call]) => {
              const wire: Record<string, unknown> = { type: "function", function: { name: call.name, arguments: call.args } };
              if (call.id !== null) wire.id = call.id;
              return wire;
            });
        }
        encode("response", "assistant", assembled, partCap, Buffer.byteLength(JSON.stringify(assembled)));
      } else if (this.errorBodyRaw !== null) {
        let value: unknown;
        try {
          value = JSON.parse(this.errorBodyRaw);
        } catch {
          value = { raw: this.errorBodyRaw };
        }
        encode("error", null, value, partCap, Buffer.byteLength(this.errorBodyRaw));
      }
      return parts;
    } catch {
      return [];
    }
  }
}

/** Request bodies above this are forwarded but not parsed (sizes still counted). */
export const MAX_BODY_PARSE_BYTES = 64 * 1024 * 1024;
/** Non-streaming response head kept for the single end-parse. */
export const MAX_RESPONSE_PARSE_BYTES = 4 * 1024 * 1024;
