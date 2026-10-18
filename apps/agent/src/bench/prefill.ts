import { randomUUID } from "node:crypto";
import type { PrefillConfig, PrefillResult, PrefillSample, PrefillSizeResult } from "@irori/core";
import { benchStream, estimateTokenCount, labBody, median, round2, thinkingOffFields } from "./stream.js";

/**
 * Prefill bench — sequential context-size sweep (sparkDash PrefillBench
 * protocol). One request per sample with a fresh unique salt so a prior size
 * cannot be a prefix-cache hit; 8 generated tokens; rate = server `timings`
 * when the backend reports them, else (prompt − cached) / (TTFT − calibrated
 * overhead), the correction capped at 50% of TTFT and flagged low-confidence
 * above 30%.
 */

const GEN_MAX_TOKENS = 8;
const WARMUP_TARGET_TOKENS = 512;
const CALIBRATION_TOKENS = 16;
const CALIBRATION_SAMPLES = 3;
const MAX_OVERHEAD_CORRECTION = 0.5;
const LOW_CONFIDENCE_OVERHEAD_SHARE = 0.3;

/** Common short English words (~1 BPE token each with a leading space). */
const FILLER_WORDS =
  "the of and to in is you that it he was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time".split(
    " ",
  );

function fillerText(count: number): string {
  const words = new Array<string>(count);
  let state = 0x2545f491;
  for (let i = 0; i < count; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    words[i] = FILLER_WORDS[(state >>> 8) % FILLER_WORDS.length]!;
  }
  return " " + words.join(" ");
}

/** Unique-prefix prompt aimed at `targetTokens`; fresh salt defeats prefix-cache. */
export function buildPrefillPrompt(targetTokens: number, salt: string): string {
  const n = Math.max(8, Math.round(Number(targetTokens) || 0));
  const header = `[prefill-bench ${salt}]\nIgnore the filler below. Reply with the single word OK.\n`;
  const footer = "\nReply OK.";
  const reserved = estimateTokenCount(header + footer);
  const fillTokens = Math.max(1, n - reserved);
  return header + fillerText(fillTokens) + footer;
}

/** Samples per size: big contexts take minutes each, so they get fewer repeats. */
export function repeatsForSize(tokens: number): number {
  const n = Number(tokens) || 0;
  if (n <= 32_768) return 3;
  if (n <= 131_072) return 2;
  return 1;
}

/** 90 s floor, ~8 ms/token, 45 min cap — 256k at ~200 tok/s is ~22 min. */
export function timeoutMsForSize(tokens: number): number {
  const n = Math.max(0, Number(tokens) || 0);
  return Math.min(2_700_000, Math.max(90_000, 60_000 + n * 8));
}

export interface PrefillSampleInput {
  promptTokens: number;
  cachedTokens: number;
  ttftMs: number;
  serverPromptMs: number | null;
  serverPromptN: number | null;
}

/**
 * Turn one raw sample into a prefill rate. "server" = backend-reported
 * prompt time; "ttft" = computed tokens over TTFT minus calibrated overhead.
 */
export function rateFromSample(s: PrefillSampleInput, overheadMs = 0): PrefillSample {
  if (s.serverPromptMs !== null && s.serverPromptMs > 0 && s.serverPromptN !== null && s.serverPromptN > 0) {
    return { promptTokens: s.promptTokens, cachedTokens: s.cachedTokens, ttftMs: round2(s.ttftMs), prefillTps: round2((s.serverPromptN / s.serverPromptMs) * 1000), method: "server", lowConfidence: false, reason: null };
  }
  const computed = Math.max(0, s.promptTokens - s.cachedTokens);
  if (!(s.ttftMs > 0)) {
    return { promptTokens: s.promptTokens, cachedTokens: s.cachedTokens, ttftMs: 0, prefillTps: 0, method: "ttft", lowConfidence: false, reason: "No first token was streamed back, so no prefill time was measured" };
  }
  if (computed <= 0) {
    return { promptTokens: s.promptTokens, cachedTokens: s.cachedTokens, ttftMs: round2(s.ttftMs), prefillTps: 0, method: "ttft", lowConfidence: false, reason: "The whole prompt was served from the prefix cache, so no prefill was measured" };
  }
  const overhead = Math.max(0, overheadMs);
  const effectiveMs = Math.max(s.ttftMs - overhead, s.ttftMs * (1 - MAX_OVERHEAD_CORRECTION));
  return {
    promptTokens: s.promptTokens,
    cachedTokens: s.cachedTokens,
    ttftMs: round2(s.ttftMs),
    prefillTps: round2((computed / effectiveMs) * 1000),
    method: "ttft",
    lowConfidence: overhead > s.ttftMs * LOW_CONFIDENCE_OVERHEAD_SHARE,
    reason: null,
  };
}

export interface PrefillHooks {
  apiKey?: string | null;
  onProgress: (index: number, total: number, label: string, liveTps: number | null) => void;
  signal: AbortSignal;
}

export async function runPrefill(config: PrefillConfig, hooks: PrefillHooks): Promise<PrefillResult> {
  const url = `http://${config.host}:${config.port}/v1/chat/completions`;
  const total = config.sizes.length;

  // Calibration: 3 tiny requests measure the fixed per-request overhead.
  hooks.onProgress(0, total, "calibration", null);
  const overheadSamples: number[] = [];
  for (let i = 0; i < CALIBRATION_SAMPLES; i++) {
    const res = await benchStream(url, labBody(config.model, buildPrefillPrompt(CALIBRATION_TOKENS, randomUUID().slice(0, 8)), GEN_MAX_TOKENS, thinkingOffFields()), hooks.signal, {
      apiKey: hooks.apiKey,
      stripThinkingOn400: true,
    });
    if (!res.error && res.ttftMs !== null && (res.completionTokens ?? 0) > 0) overheadSamples.push(res.ttftMs);
  }
  const overheadMs = overheadSamples.length > 0 ? median(overheadSamples) : 0;

  // Warmup: one mid-size request so allocator/rope setup is not billed to size 1.
  hooks.onProgress(0, total, "warmup", null);
  await benchStream(url, labBody(config.model, buildPrefillPrompt(WARMUP_TARGET_TOKENS, randomUUID().slice(0, 8)), GEN_MAX_TOKENS, thinkingOffFields()), hooks.signal, {
    apiKey: hooks.apiKey,
    stripThinkingOn400: true,
  });

  const sizes: PrefillSizeResult[] = [];
  for (let i = 0; i < total; i++) {
    if (hooks.signal.aborted) throw new Error("canceled");
    const tokens = config.sizes[i]!;
    hooks.onProgress(i, total, `${label(tokens)} prefill`, null);
    const repeats = repeatsForSize(tokens);
    const samples: PrefillSample[] = [];
    let rawSamples: PrefillSampleInput[] = [];
    for (let r = 0; r < repeats; r++) {
      if (hooks.signal.aborted) throw new Error("canceled");
      const ctrl = new AbortController();
      const onParentAbort = () => ctrl.abort();
      hooks.signal.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeoutMsForSize(tokens));
      try {
        const res = await benchStream(url, labBody(config.model, buildPrefillPrompt(tokens, randomUUID().slice(0, 8)), GEN_MAX_TOKENS, thinkingOffFields()), ctrl.signal, {
          apiKey: hooks.apiKey,
          stripThinkingOn400: true,
        });
        if (res.error) {
          samples.push({
            promptTokens: res.promptTokens ?? 0,
            cachedTokens: res.cachedTokens ?? 0,
            ttftMs: 0,
            prefillTps: 0,
            method: "ttft",
            lowConfidence: false,
            reason: res.error,
          });
        } else {
          rawSamples.push({
            promptTokens: res.promptTokens ?? estimateTokenCount(buildPrefillPrompt(tokens, "")),
            cachedTokens: res.cachedTokens ?? 0,
            ttftMs: res.ttftMs ?? 0,
            serverPromptMs: res.serverPromptMs,
            serverPromptN: res.serverPromptN,
          });
        }
      } finally {
        clearTimeout(timer);
        hooks.signal.removeEventListener("abort", onParentAbort);
      }
    }
    for (const raw of rawSamples) samples.push(rateFromSample(raw, overheadMs));
    const tpsList = samples.filter((s) => s.prefillTps > 0).map((s) => s.prefillTps);
    const ttftList = samples.filter((s) => s.ttftMs > 0).map((s) => s.ttftMs);
    sizes.push({
      tokens,
      repeats,
      samples,
      medianTps: tpsList.length > 0 ? round2(median(tpsList)) : 0,
      ttftMs: ttftList.length > 0 ? round2(median(ttftList)) : 0,
    });
  }
  return { overheadMs: round2(overheadMs), sizes };
}

function label(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}k`;
  if (tokens >= 1000 && tokens % 1000 === 0) return `${tokens / 1000}k`;
  return String(tokens);
}
