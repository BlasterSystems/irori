import { Agent, fetch as undiciFetch } from "undici";

/**
 * Shared OpenAI-compatible SSE streaming core for the bench runners (M6).
 *
 * Decode tok/s uses the first visible token → last visible token window (not
 * stream EOF), so trailing usage/[DONE] latency does not drag the rate down.
 * Protocols follow the sparkDash engines; see
 * docs/research/IRI-007-research-brief.md.
 */

/**
 * Undici's default headersTimeout/bodyTimeout is 300 s. A 256k prefill that
 * has not produced a first token by then would be aborted even when the
 * bench's own timer is 45 min. 0 disables those idle cuts; the caller's
 * AbortSignal still bounds the request. Must use undici's own fetch — Node's
 * global fetch is a different undici build.
 */
export const BENCH_STREAM_AGENT = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export interface BenchStreamResult {
  /** First visible token, ms since request start. Null when nothing streamed. */
  ttftMs: number | null;
  /** Last visible token, ms since request start. */
  tLastMs: number | null;
  /** Content deltas seen (fallback token count when usage is absent). */
  deltaCount: number;
  completionTokens: number | null;
  promptTokens: number | null;
  /** prompt_tokens_details.cached_tokens (prefix-cache hits). */
  cachedTokens: number | null;
  /** llama.cpp server-measured prompt processing. */
  serverPromptMs: number | null;
  serverPromptN: number | null;
  content: string;
  error: string | null;
}

export interface BenchStreamOptions {
  apiKey?: string | null;
  /** Per-delta callback (delta token index within the stream). */
  onDelta?: (deltaCount: number) => void;
  /** Retry once with thinking fields stripped on HTTP 400. */
  stripThinkingOn400?: boolean;
}

/** Chat-completions request body with the lab protocol (temp 0, thinking off). */
export function labBody(model: string | null, prompt: string, maxTokens: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: model ?? undefined,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature: 0,
    top_p: 1,
    stream: true,
    stream_options: { include_usage: true },
    ...extra,
  };
}

/** Thinking-off request fields (Qwen/DeepSeek/GLM-style template switches). */
export function thinkingOffFields(): Record<string, unknown> {
  return {
    chat_template_kwargs: { enable_thinking: false, thinking: false, thinking_mode: "disabled" },
    thinking: { type: "disabled" },
  };
}

/** Remove every thinking-related field (fallback for servers that reject them). */
export function stripThinkingFields(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  delete next.chat_template_kwargs;
  delete next.thinking;
  delete next.reasoning_effort;
  return next;
}

/** vLLM-oriented fields some OpenAI-compat servers reject with HTTP 400. */
export function stripFillForceFields(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  delete next.min_tokens;
  delete next.ignore_eos;
  delete next.stop;
  return next;
}

type SseJson = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parses one SSE event's data payload into the fields the benches need. */
function applyChunk(json: SseJson, acc: BenchStreamResult, tStart: number): void {
  // llama.cpp reports server-side timings in a chunk; capture if present.
  const timings = json.timings as Record<string, unknown> | undefined;
  if (timings && acc.serverPromptMs === null) {
    const promptMs = num(timings.prompt_ms);
    const promptN = num(timings.prompt_n);
    if (promptMs !== null && promptN !== null) {
      acc.serverPromptMs = promptMs;
      acc.serverPromptN = promptN;
    }
  }
  const choices = json.choices as Array<Record<string, unknown>> | undefined;
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  const delta = (choice?.delta ?? choice?.message) as Record<string, unknown> | undefined;
  if (delta) {
    const piece = delta.content;
    if (typeof piece === "string" && piece.length > 0) {
      if (acc.ttftMs === null) acc.ttftMs = performance.now() - tStart;
      acc.tLastMs = performance.now() - tStart;
      acc.deltaCount += 1;
      acc.content += piece;
    }
  }
  const usage = json.usage as Record<string, unknown> | undefined;
  if (usage) {
    const ct = num(usage.completion_tokens);
    if (ct !== null) acc.completionTokens = ct;
    const pt = num(usage.prompt_tokens);
    if (pt !== null) acc.promptTokens = pt;
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const cached = details ? num(details.cached_tokens) : null;
    if (cached !== null) acc.cachedTokens = cached;
  }
}

/**
 * One streaming chat-completions request. Never throws — failures land in
 * `error` so a single bad stream cannot kill a wave.
 */
export async function benchStream(url: string, body: Record<string, unknown>, signal: AbortSignal, opts: BenchStreamOptions = {}): Promise<BenchStreamResult> {
  let result = await benchStreamOnce(url, body, signal, opts);
  if (
    opts.stripThinkingOn400 &&
    result.error?.startsWith("HTTP 400") &&
    ("chat_template_kwargs" in body || "thinking" in body)
  ) {
    result = await benchStreamOnce(url, stripThinkingFields(body), signal, opts);
  }
  return result;
}

async function benchStreamOnce(url: string, body: Record<string, unknown>, signal: AbortSignal, opts: BenchStreamOptions): Promise<BenchStreamResult> {
  const acc: BenchStreamResult = {
    ttftMs: null,
    tLastMs: null,
    deltaCount: 0,
    completionTokens: null,
    promptTokens: null,
    cachedTokens: null,
    serverPromptMs: null,
    serverPromptN: null,
    content: "",
    error: null,
  };
  const tStart = performance.now();
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  const key = opts.apiKey != null ? String(opts.apiKey).trim() : "";
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await undiciFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      dispatcher: BENCH_STREAM_AGENT,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      acc.error = `HTTP ${response.status}: ${text.slice(0, 200)}`;
      return acc;
    }
    if (!response.body) {
      acc.error = "Empty response body (streaming unsupported?)";
      return acc;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let json: SseJson;
          try {
            json = JSON.parse(data) as SseJson;
          } catch {
            continue;
          }
          applyChunk(json, acc, tStart);
        }
      }
    }
  } catch (err) {
    acc.error = err instanceof Error && err.name === "AbortError" ? "Request aborted" : String(err);
  }
  return acc;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** EstimateTokenCount — ~4 chars/token for Latin / code; never 0 for non-empty text. */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 4));
}

export interface BenchCompleteResult {
  message: {
    content: string | null;
    toolCalls: Array<{ id: string; name: string; args: string }>;
  } | null;
  error: string | null;
}

/**
 * One non-streaming chat-completions request (tool-eval trials). Never
 * throws; failures land in `error`.
 */
export async function benchComplete(url: string, body: Record<string, unknown>, signal: AbortSignal, opts: BenchStreamOptions = {}): Promise<BenchCompleteResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = opts.apiKey != null ? String(opts.apiKey).trim() : "";
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await undiciFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      dispatcher: BENCH_STREAM_AGENT,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { message: null, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    const json = (await response.json()) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const message = Array.isArray(choices) ? (choices[0]?.message as Record<string, unknown> | undefined) : undefined;
    if (!message) return { message: null, error: "response has no message" };
    const rawCalls = (message.tool_calls ?? []) as Array<Record<string, unknown>>;
    return {
      message: {
        content: typeof message.content === "string" ? message.content : null,
        toolCalls: rawCalls.map((c) => {
          const fn = (c.function ?? {}) as Record<string, unknown>;
          return { id: String(c.id ?? ""), name: String(fn.name ?? ""), args: typeof fn.arguments === "string" ? fn.arguments : "{}" };
        }),
      },
      error: null,
    };
  } catch (err) {
    return { message: null, error: err instanceof Error && err.name === "AbortError" ? "Request aborted" : String(err) };
  }
}
