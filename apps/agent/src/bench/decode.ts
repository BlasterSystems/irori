import type { DecodeConfig, DecodeLevel, DecodeResult, DecodeStreamResult } from "@irori/core";
import { benchStream, labBody, mean, median, round2, sleep, stripFillForceFields, thinkingOffFields } from "./stream.js";

/**
 * Decode bench — concurrent streaming decode tok/s at rising concurrency
 * (sparkDash DecodeBench protocol). Sequential waves; per-stream rate =
 * (completion_tokens − 1) / (last − first visible token); aggregate =
 * total decode tokens / concurrent first→last window. Output types are
 * prompt labels only — never response_format/grammars.
 */

const PER_REQUEST_TIMEOUT_MS = 360_000;
const WAVE_TIMEOUT_MS = 360_000;

// ─── Prompt generation (unique per stream, similar length) ──

const PROSE_TOPICS = [
  "a foggy harbor at dawn",
  "a night train crossing the plains",
  "an old lighthouse keeper's routine",
  "a rooftop garden in a dense city",
  "the last day of a summer fair",
  "a radio repair shop before closing time",
  "a ferry crossing in bad weather",
  "a mountain road after the first snow",
];

const JSON_KEYS = [
  "sensor readings with timestamps",
  "library books with authors and years",
  "flight segments with airports and times",
  "recipe steps with ingredients",
  "invoice lines with quantities and prices",
  "log entries with levels and messages",
  "calendar events with attendees",
  "inventory items with locations",
];

const CODE_TASKS = [
  "def binary_search(nums, target) -> int: index of target in a sorted list, or -1.",
  "def merge_sort(nums) -> list: stable sort of a list of ints, returning a new list.",
  "def is_palindrome(s) -> bool: true when s is a palindrome ignoring case and non-alphanumerics.",
  "def two_sum(nums, target) -> tuple: indices of the two entries adding to target, or None.",
  "def flatten(nested) -> list: flatten an arbitrarily nested list of lists into values in order.",
  "def word_frequencies(text) -> dict: lowercase word -> count, ignoring punctuation.",
  "def roman_to_int(s) -> int: value of a roman numeral.",
  "def dedupe_consecutive(items) -> list: collapse consecutive duplicates, keep order.",
];

/** Distinct, length-similar prompt for stream `index` (0-based). */
export function decodePrompt(type: DecodeConfig["promptType"], index: number): string {
  switch (type) {
    case "structured": {
      const start = 1 + index * 1000;
      return `Count from ${start} to ${start + 199}. Output the numbers separated by single spaces, nothing else.`;
    }
    case "prose":
      return `Write a description of about 300 words of ${PROSE_TOPICS[index % PROSE_TOPICS.length]}. Plain prose only, no headings or lists.`;
    case "json": {
      const keys = JSON_KEYS[index % JSON_KEYS.length];
      const n = 8 + (index % 3) * 2;
      return `Output a JSON object with a "data" array of ${n} entries describing ${keys}. Each entry needs 4 to 6 fields. Output only valid JSON, no markdown fence.`;
    }
    case "code": {
      if (index < CODE_TASKS.length) return `Implement ${CODE_TASKS[index]!} Python only, no comments.`;
      return `Implement function number ${index + 1}: ${CODE_TASKS[index % CODE_TASKS.length]!} Add a variant suffix. Python only, no comments.`;
    }
  }
}

// ─── Live rate from the run's own streams ────────────────

/**
 * Rolling 2 s window of tokens received across all streams, sampled 1/s.
 * The window starts where tokens start (prefill is not decode time) and
 * reports null before the first token so the UI never shows a misleading 0.
 */
export class LiveRate {
  private readonly counts: number[];
  private readonly samples: Array<[number, number]>;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    streams: number,
    private readonly onLive: (tps: number | null) => void,
    private readonly intervalMs = 1000,
    private readonly windowMs = 2000,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.counts = new Array(streams).fill(0);
    this.samples = [[this.now(), 0]];
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  note(streamIndex: number, deltaCount: number): void {
    if (streamIndex >= 0 && streamIndex < this.counts.length) this.counts[streamIndex] = deltaCount;
  }

  tick(): void {
    const t = this.now();
    const total = this.counts.reduce((a, b) => a + b, 0);
    this.samples.push([t, total]);
    while (this.samples.length > 2 && this.samples[1]![1] === 0) this.samples.shift();
    while (this.samples.length > 2 && t - this.samples[0]![0] > this.windowMs) this.samples.shift();
    const [t0, n0] = this.samples[0]!;
    const [t1, n1] = this.samples[this.samples.length - 1]!;
    if (t1 <= t0 || n1 === 0) return;
    try {
      this.onLive(round2(((n1 - n0) / ((t1 - t0) / 1000)) * 10) / 10);
    } catch {
      /* the display must never break a run */
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = null;
    try {
      this.onLive(null);
    } catch {
      /* ignore */
    }
  }
}

/** One stream's public result. */
function streamResult(res: Awaited<ReturnType<typeof benchStream>>): DecodeStreamResult {
  const decodeTokens = res.completionTokens ?? res.deltaCount;
  const decodeMs = res.ttftMs !== null && res.tLastMs !== null ? res.tLastMs - res.ttftMs : 0;
  // (completion_tokens − 1) / window: the first token is prefill's outcome, not decode.
  const tokens = Math.max(0, (res.completionTokens ?? res.deltaCount) - 1);
  return {
    ttftMs: res.ttftMs !== null ? round2(res.ttftMs) : null,
    decodeTps: decodeMs > 0 ? round2((tokens / decodeMs) * 1000) : 0,
    decodeTokens,
    error: res.error,
  };
}

export interface DecodeHooks {
  apiKey?: string | null;
  onProgress: (index: number, total: number, label: string, liveTps: number | null) => void;
  /** Cooperative cancel: checked between waves and inside waits. */
  signal: AbortSignal;
}

export async function runDecode(config: DecodeConfig, hooks: DecodeHooks): Promise<DecodeResult> {
  const url = `http://${config.host}:${config.port}/v1/chat/completions`;
  const levels: DecodeLevel[] = [];
  const total = config.concurrencies.length;

  // Warmup: one short stream so JIT / lazy loads are not billed to the first wave.
  hooks.onProgress(0, total, "warmup", null);
  const warmCtrl = new AbortController();
  const onParentAbort = () => warmCtrl.abort();
  hooks.signal.addEventListener("abort", onParentAbort, { once: true });
  try {
    await benchStream(url, labBody(config.model, decodePrompt(config.promptType, 0), 32, thinkingOffFields()), warmCtrl.signal, {
      apiKey: hooks.apiKey,
      stripThinkingOn400: true,
    });
  } catch {
    /* best-effort */
  } finally {
    hooks.signal.removeEventListener("abort", onParentAbort);
  }

  for (let i = 0; i < config.concurrencies.length; i++) {
    if (hooks.signal.aborted) throw new Error("canceled");
    const concurrency = config.concurrencies[i]!;
    const level = await runWave(config, url, concurrency, i, total, hooks);
    levels.push(level);
  }
  return { levels };
}

async function runWave(
  config: DecodeConfig,
  url: string,
  concurrency: number,
  index: number,
  total: number,
  hooks: DecodeHooks,
): Promise<DecodeLevel> {
  const waveStart = performance.now();
  const live = new LiveRate(concurrency, (tps) => hooks.onProgress(index, total, `×${concurrency}`, tps));
  const controllers: AbortController[] = [];

  const promises = Array.from({ length: concurrency }, (_, streamIndex) => {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const onParentAbort = () => ctrl.abort();
    if (hooks.signal.aborted) ctrl.abort();
    else hooks.signal.addEventListener("abort", onParentAbort, { once: true });

    const body = {
      ...labBody(config.model, decodePrompt(config.promptType, streamIndex), config.maxTokens, thinkingOffFields()),
      min_tokens: config.maxTokens,
      ignore_eos: true,
      stop: [],
    };
    const streamStart = performance.now();
    let deltaCount = 0;
    return (async () => {
      const timeout = setTimeout(() => ctrl.abort(), PER_REQUEST_TIMEOUT_MS);
      try {
        let res = await benchStream(url, body, ctrl.signal, {
          apiKey: hooks.apiKey,
          stripThinkingOn400: true,
          onDelta: (n) => {
            deltaCount = n;
            live.note(streamIndex, n);
          },
        });
        if (res.error?.startsWith("HTTP 400") && "min_tokens" in body) {
          res = await benchStream(url, stripFillForceFields(body), ctrl.signal, {
            apiKey: hooks.apiKey,
            stripThinkingOn400: true,
            onDelta: (n) => {
              deltaCount = n;
              live.note(streamIndex, n);
            },
          });
        }
        return { res, tFirstAbs: res.ttftMs !== null ? streamStart + res.ttftMs : null, tLastAbs: res.tLastMs !== null ? streamStart + res.tLastMs : null };
      } finally {
        clearTimeout(timeout);
        hooks.signal.removeEventListener("abort", onParentAbort);
      }
    })();
  });

  let waveTimedOut = false;
  const waveTimer = setTimeout(() => {
    waveTimedOut = true;
    for (const c of controllers) c.abort();
  }, WAVE_TIMEOUT_MS);

  let streams: Array<{ res: Awaited<ReturnType<typeof benchStream>>; tFirstAbs: number | null; tLastAbs: number | null }>;
  try {
    streams = await Promise.all(promises);
  } finally {
    live.stop();
    clearTimeout(waveTimer);
  }
  const durationMs = round2(performance.now() - waveStart);

  if (waveTimedOut && streams.every((s) => s.res.error)) {
    return {
      concurrency,
      streamsOk: 0,
      streamsFailed: concurrency,
      meanDecodeTps: 0,
      medianDecodeTps: 0,
      minDecodeTps: 0,
      maxDecodeTps: 0,
      aggregateDecodeTps: 0,
      meanTtftMs: 0,
      medianTtftMs: 0,
      totalDecodeTokens: 0,
      totalCompletionTokens: 0,
      durationMs,
      error: `Wave timed out after ${WAVE_TIMEOUT_MS}ms`,
      streams: [],
    };
  }

  const ok = streams.filter((s) => !s.res.error && (s.res.completionTokens ?? s.res.deltaCount) > 0);
  const failed = streams.length - ok.length;
  const decodeTpsList = ok.map((s) => streamResult(s.res).decodeTps);
  const ttftList = ok.map((s) => s.res.ttftMs ?? 0).filter((n) => n > 0);
  const totalDecodeTokens = ok.reduce((sum, s) => sum + (s.res.completionTokens ?? s.res.deltaCount), 0);
  const totalCompletionTokens = ok.reduce((sum, s) => sum + (s.res.completionTokens ?? s.res.deltaCount), 0);

  // Client aggregate over the concurrent first→last token window.
  let aggregateDecodeTps = 0;
  const firsts = ok.map((s) => s.tFirstAbs).filter((t): t is number => t !== null);
  const lasts = ok.map((s) => s.tLastAbs).filter((t): t is number => t !== null);
  if (ok.length > 0 && firsts.length > 0 && lasts.length > 0) {
    const windowMs = Math.max(...lasts) - Math.min(...firsts);
    if (windowMs > 0) aggregateDecodeTps = round2((totalDecodeTokens / windowMs) * 1000);
  }

  return {
    concurrency,
    streamsOk: ok.length,
    streamsFailed: failed,
    meanDecodeTps: round2(mean(decodeTpsList)),
    medianDecodeTps: round2(median(decodeTpsList)),
    minDecodeTps: decodeTpsList.length > 0 ? round2(Math.min(...decodeTpsList)) : 0,
    maxDecodeTps: decodeTpsList.length > 0 ? round2(Math.max(...decodeTpsList)) : 0,
    aggregateDecodeTps,
    meanTtftMs: round2(mean(ttftList)),
    medianTtftMs: round2(median(ttftList)),
    totalDecodeTokens,
    totalCompletionTokens,
    durationMs,
    error: ok.length === 0 ? (streams[0]?.res.error ?? "no streams produced tokens") : null,
    streams: streams.slice(0, 32).map((s) => streamResult(s.res)),
  };
}

/** Small sleep helper re-export for tests. */
export const decodeSleep = sleep;
