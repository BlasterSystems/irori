import type { LlmBackend, LlmPortSnapshot } from "@irori/core";

/**
 * LlmPortProbe — polls one LLM engine port on the agent's node and turns it
 * into an `llmPortSnapshotSchema` shape. One instance per port, owned by
 * main.ts; detection is cached per port and refreshed every 60 s (or after
 * 3 consecutive unreachable probes).
 *
 * Detection order and per-backend series follow docs/research/IRI-004:
 *   /slots → /api/v0/models → /api/tags → /v1/models → /metrics //
 *   /server_info → /health → else OpenAI-compatible (vllm).
 *
 * Rates are cumulative-counter diffs over the poll window (guard 0 < dt < 10 s;
 * idle → 0, unpublished → null). Exceptions per the brief: SGLang's
 * gen_throughput gauge is sticky (change-gated, 6 s expiry) and TensorFold's
 * `live{}` block is server-computed and used as-is.
 */

const FETCH_TIMEOUT_MS = 3_000;
const LMSTUDIO_TIMEOUT_MS = 8_000;
const RATE_WINDOW_MAX_S = 10;
const SGLANG_STICKY_TTL_MS = 6_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_DETECT_TTL_MS = 60_000;

export interface LlmPortProbeOptions {
  port: number;
  /** Probe target host; defaults to 127.0.0.1 (the agent's own node). */
  host?: string;
  /** Optional bearer token sent on every request to this port. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  detectTtlMs?: number;
}

interface Detection {
  backend: LlmBackend;
  detected: boolean;
  at: number;
}

interface Window {
  value: number;
  at: number;
}

interface Sample {
  /** null when the window is invalid (paused/reset counter) — never guess. */
  rate: number | null;
  delta: number;
  dtSec: number;
  seeded: boolean;
}

/** The metric half of LlmPortSnapshot; identity fields are added by probe(). */
type LlmMetrics = Partial<
  Pick<
    LlmPortSnapshot,
    | "decodeTps"
    | "prefillTps"
    | "queueRunning"
    | "queueWaiting"
    | "kvCachePct"
    | "ttftP95Ms"
    | "e2eP95Ms"
    | "itlP95Ms"
    | "engineMeta"
    | "tokens"
  >
>;

interface PromSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const Q27_METRICS_RE = /(?:^|\n)q27_(?:decode_tokens_(?:processed_)?total|requests_total)(?:\{|\s)/;

// ─── Prometheus text helpers ──────────────────────────────────────────────

/** Prometheus label escapes; anything else passes through (\" → ", \\ → \). */
const LABEL_ESCAPES: Record<string, string> = { n: "\n", t: "\t" };

/** Parse a `{a="1",b="2"}` label list; quoted values only (Prometheus text). */
function parseLabels(src: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < src.length) {
    const eq = src.indexOf("=", i);
    if (eq < 0) break;
    const key = src.slice(i, eq).trim();
    if (src[eq + 1] !== '"') break;
    let j = eq + 2;
    let val = "";
    while (j < src.length && src[j] !== '"') {
      if (src[j] === "\\" && j + 1 < src.length) {
        val += LABEL_ESCAPES[src[j + 1]!] ?? src[j + 1]!;
        j += 2;
      } else {
        val += src[j];
        j += 1;
      }
    }
    labels[key] = val;
    i = j + 1;
    if (src[i] === ",") i += 1;
  }
  return labels;
}

export function parsePromText(text: string): PromSeries[] {
  const out: PromSeries[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    const brace = line.indexOf("{");
    if (brace > 0) {
      const close = line.lastIndexOf("}");
      name = line.slice(0, brace);
      if (close > brace) {
        labels = parseLabels(line.slice(brace + 1, close));
        rest = line.slice(close + 1);
      } else {
        rest = "";
      }
    } else {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp);
    }
    const value = Number(rest.trim());
    if (name.length === 0 || !Number.isFinite(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

/** Sum a metric across label sets; null when the series is absent. */
export function promSum(series: PromSeries[], name: string): number | null {
  let sum = 0;
  let saw = false;
  for (const s of series) {
    if (s.name === name) {
      sum += s.value;
      saw = true;
    }
  }
  return saw ? sum : null;
}

/** Max across label sets — for TP-rank gauges (summing double-counts). */
export function promMax(series: PromSeries[], name: string): number | null {
  let max: number | null = null;
  for (const s of series) {
    if (s.name === name && (max === null || s.value > max)) max = s.value;
  }
  return max;
}

/** Sum a metric across label sets matching a label predicate. */
export function promLabeledSum(
  series: PromSeries[],
  name: string,
  match: (labels: Record<string, string>) => boolean,
): number | null {
  let sum = 0;
  let saw = false;
  for (const s of series) {
    if (s.name === name && match(s.labels)) {
      sum += s.value;
      saw = true;
    }
  }
  return saw ? sum : null;
}

export interface PromHistogram {
  /** Sorted ascending by upper bound; +Inf retained last. */
  buckets: { upper: number; count: number }[];
  total: number | null;
}

/**
 * Parse `<base>_bucket{le=...}` / `<base>_count`. Counts are summed per le
 * across label sets. A body whose +Inf bucket does not equal the summed
 * `_count` is inconsistent (truncated/relabel-filtered) and is rejected.
 */
export function parsePromHistogram(series: PromSeries[], base: string): PromHistogram {
  const perLe = new Map<string, number>();
  let count = 0;
  let sawCount = false;
  for (const s of series) {
    if (s.name === `${base}_bucket`) {
      const le = s.labels.le;
      if (le === undefined) continue;
      perLe.set(le, (perLe.get(le) ?? 0) + s.value);
    } else if (s.name === `${base}_count`) {
      count += s.value;
      sawCount = true;
    }
  }
  if (!sawCount) return { buckets: [], total: null };
  const inf = perLe.get("+Inf");
  if (inf === undefined || inf !== count) return { buckets: [], total: null };
  const buckets = [...perLe.entries()]
    .map(([le, c]) => ({ upper: le === "+Inf" ? Infinity : Number(le), count: c }))
    .filter((b) => Number.isFinite(b.upper))
    .sort((a, b) => a.upper - b.upper);
  buckets.push({ upper: Infinity, count: inf });
  return { buckets, total: count };
}

/** Interpolated quantile; null when the target lands in the unbounded +Inf tail. */
export function promHistogramQuantile(
  buckets: { upper: number; count: number }[],
  total: number | null,
  q: number,
): number | null {
  if (buckets.length === 0 || total === null || total <= 0) return null;
  const target = q * total;
  let prevCount = 0;
  let prevUpper = 0;
  for (const b of buckets) {
    if (b.count >= target) {
      if (!Number.isFinite(b.upper)) return null;
      if (b.count === prevCount) return b.upper;
      return prevUpper + (b.upper - prevUpper) * ((target - prevCount) / (b.count - prevCount));
    }
    prevCount = b.count;
    prevUpper = b.upper;
  }
  return null;
}

/**
 * Normalize HF hub cache paths (`.../models--org--name/snapshots/<sha>`) to
 * `org/name`; pass through short ids; null for empty input.
 */
export function normalizeModelId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // HF hub cache paths win over the "already short" check — they contain "/".
  const marker = trimmed.lastIndexOf("models--");
  if (marker >= 0) {
    const seg = trimmed.slice(marker + "models--".length);
    const end = seg.indexOf("/");
    const orgName = end >= 0 ? seg.slice(0, end) : seg; // drop /snapshots/<sha>
    const sep = orgName.indexOf("--");
    if (sep > 0) return `${orgName.slice(0, sep)}/${orgName.slice(sep + 2)}`;
    return orgName.length > 0 ? orgName : null;
  }
  return trimmed;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstString(rows: unknown[], key: string): string | null {
  for (const row of rows) {
    if (isObject(row) && typeof row[key] === "string") return row[key];
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function healthLooksLikeExl3(body: Record<string, unknown>): boolean {
  if (body.backend === "exl3") return true;
  return typeof body.ok === "boolean" && typeof body.busy === "boolean";
}

function looksLikeSglangInfo(body: Record<string, unknown>): boolean {
  return (
    typeof body.version === "string" ||
    typeof body.model_path === "string" ||
    Array.isArray(body.internal_states) ||
    typeof body.max_total_num_tokens === "number" ||
    typeof body.context_length === "number"
  );
}

function ownedByToBackend(ownedBy: string): LlmBackend | null {
  const m = ownedBy.match(/ds4|sglang|exl3|q27|tensorfold/i);
  if (m) return m[0].toLowerCase() as LlmBackend;
  if (/^ollama$/i.test(ownedBy)) return "ollama";
  return null;
}

// ─── Probe ────────────────────────────────────────────────────────────────

export class LlmPortProbe {
  readonly port: number;
  readonly host: string;
  /** `${host}:${port}` — stable key for the agent's probe map. */
  readonly key: string;

  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly detectTtlMs: number;
  private readonly headers: Record<string, string>;

  private detection: Detection | null = null;
  private consecutiveFailures = 0;
  private model: string | null = null;
  /** Context length captured from /v1/models (max_model_len / context_length). */
  private contextLength: number | null = null;
  private windows = new Map<string, Window>();
  private sglangSticky: { value: number; liveUntil: number } | null = null;
  /** Successful HTTP responses observed during the current probe. */
  private hits = 0;

  constructor(options: LlmPortProbeOptions) {
    this.port = options.port;
    this.host = options.host ?? "127.0.0.1";
    this.key = `${this.host}:${this.port}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.detectTtlMs = options.detectTtlMs ?? DEFAULT_DETECT_TTL_MS;
    this.headers = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  }

  /**
   * Probe the port once. `detectOnly` (workers) reports backend/model only and
   * leaves the rate windows untouched.
   */
  async probe(detectOnly: boolean): Promise<LlmPortSnapshot> {
    this.hits = 0;
    const now = this.now();
    let det = this.detection;
    if (det === null || now - det.at > this.detectTtlMs) {
      det = await this.detect();
      this.detection = det;
    }

    let ok = true;
    let metrics: LlmMetrics = {};
    if (!detectOnly && det.detected) {
      try {
        metrics = await this.applyMetrics(det.backend);
      } catch {
        ok = false;
        metrics = {};
      }
    }
    if (this.hits === 0) ok = false; // nothing answered — unreachable port

    if (ok) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) this.detection = null;
    }

    return {
      port: this.port,
      host: this.host,
      backend: det.backend,
      detected: det.detected,
      model: this.model,
      decodeTps: metrics.decodeTps ?? null,
      prefillTps: metrics.prefillTps ?? null,
      queueRunning: metrics.queueRunning ?? null,
      queueWaiting: metrics.queueWaiting ?? null,
      kvCachePct: metrics.kvCachePct ?? null,
      ttftP95Ms: metrics.ttftP95Ms ?? null,
      e2eP95Ms: metrics.e2eP95Ms ?? null,
      itlP95Ms: metrics.itlP95Ms ?? null,
      engineMeta: metrics.engineMeta ?? null,
      tokens: metrics.tokens ?? null,
      probedAtMs: this.now(),
    };
  }

  // ── transport helpers ──

  private async getJson(
    path: string,
    timeoutMs = FETCH_TIMEOUT_MS,
  ): Promise<{ status: number; body: unknown } | null> {
    try {
      const res = await this.fetchImpl(`http://${this.host}:${this.port}${path}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      this.hits += 1;
      const body = await res.json();
      return { status: res.status, body };
    } catch {
      return null;
    }
  }

  private async getText(
    path: string,
    timeoutMs = FETCH_TIMEOUT_MS,
  ): Promise<{ status: number; text: string } | null> {
    try {
      const res = await this.fetchImpl(`http://${this.host}:${this.port}${path}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      this.hits += 1;
      const text = await res.text();
      return { status: res.status, text };
    } catch {
      return null;
    }
  }

  // ── detection ──

  private async detect(): Promise<Detection> {
    // 1. llama.cpp /slots — a JSON array (or an auth wall) settles it; never
    //    probed again once the port is classified.
    const slots = await this.getJson("/slots");
    if (slots !== null) {
      if (Array.isArray(slots.body) || slots.status === 401 || slots.status === 403) {
        await this.fetchLlamaProps();
        return { backend: "llama.cpp", detected: true, at: this.now() };
      }
    }

    // 2. LM Studio answers 200 JSON on every path, so it must be probed
    //    before /v1/models (8 s budget — the brief's LM Studio rule).
    const lms = await this.getJson("/api/v0/models", LMSTUDIO_TIMEOUT_MS);
    if (
      lms !== null &&
      isObject(lms.body) &&
      Array.isArray(lms.body.data) &&
      lms.body.data.length > 0
    ) {
      this.model = firstString(lms.body.data, "id");
      // TensorFold 1.1+ serves an LM-Studio-compatible /api/v0/models; prefer
      // the owned_by classification so its metrics keep flowing (the lmstudio
      // applier is a no-op and would blank the card).
      const ownedBy = ownedByToBackend(firstString(lms.body.data, "owned_by") ?? "");
      return { backend: ownedBy ?? "lmstudio", detected: true, at: this.now() };
    }

    // 3. Ollama /api/tags — top-level models array.
    const tags = await this.getJson("/api/tags");
    if (
      tags !== null &&
      isObject(tags.body) &&
      Array.isArray(tags.body.models) &&
      tags.body.models.length > 0
    ) {
      this.model = firstString(tags.body.models, "name");
      return { backend: "ollama", detected: true, at: this.now() };
    }

    // 4. OpenAI-compatible — classify by data[0].owned_by.
    let openaiCompat = false;
    const v1 = await this.getJson("/v1/models");
    if (v1 !== null && (v1.status === 200 || v1.status === 401)) {
      openaiCompat = true;
      const data = isObject(v1.body) && Array.isArray(v1.body.data) ? v1.body.data : [];
      const first = isObject(data[0]) ? data[0] : null;
      if (first !== null) {
        if (typeof first.id === "string") this.model = normalizeModelId(first.id);
        const ctx = num(first.max_model_len) ?? num(first.context_length);
        if (ctx !== null) this.contextLength = ctx;
      }
      const backend = ownedByToBackend(
        first !== null && typeof first.owned_by === "string" ? first.owned_by : "",
      );
      if (backend !== null) return { backend, detected: true, at: this.now() };
    }

    // 5. Fall-through probes.
    const metricsText = await this.getText("/metrics");
    if (metricsText !== null && /(?:^|\n)ds4_tokens_decoded_total(?:\{|\s)/.test(metricsText.text)) {
      return { backend: "ds4", detected: true, at: this.now() };
    }
    const sgInfo = await this.fetchSglangInfo();
    if (sgInfo !== null && isObject(sgInfo.body) && looksLikeSglangInfo(sgInfo.body)) {
      return { backend: "sglang", detected: true, at: this.now() };
    }
    const health = await this.getJson("/health");
    if (health !== null && isObject(health.body) && healthLooksLikeExl3(health.body)) {
      return { backend: "exl3", detected: true, at: this.now() };
    }
    if (metricsText !== null && Q27_METRICS_RE.test(metricsText.text)) {
      return { backend: "q27", detected: true, at: this.now() };
    }
    if (openaiCompat) return { backend: "vllm", detected: true, at: this.now() };
    return { backend: "unknown", detected: false, at: this.now() };
  }

  // ── per-backend metric appliers ──

  private async applyMetrics(backend: LlmBackend): Promise<LlmMetrics> {
    switch (backend) {
      case "vllm":
        return this.applyVllmMetrics();
      case "llama.cpp":
        return this.applyLlamaCppMetrics();
      case "sglang":
        return this.applySglangMetrics();
      case "exl3":
        return this.applyExl3Health();
      case "tensorfold":
        return this.applyTensorFoldHealth();
      case "q27":
        return this.applyQ27Metrics();
      case "ds4":
        return this.applyDs4Metrics();
      case "lmstudio":
      case "ollama":
      case "unknown":
        return {};
    }
  }

  /** Counter window update + rate. Seeds on first sample (rate 0). */
  private sample(name: string, value: number | null): Sample | null {
    if (value === null) return null;
    const now = this.now();
    const prev = this.windows.get(name);
    this.windows.set(name, { value, at: now });
    if (prev === undefined) return { rate: 0, delta: 0, dtSec: 0, seeded: true };
    const dtSec = (now - prev.at) / 1000;
    if (!(dtSec > 0) || dtSec >= RATE_WINDOW_MAX_S) {
      return { rate: null, delta: 0, dtSec: 0, seeded: false };
    }
    if (value < prev.value) return { rate: null, delta: 0, dtSec: 0, seeded: false };
    const delta = value - prev.value;
    return { rate: round2(Math.max(0, delta / dtSec)), delta, dtSec, seeded: false };
  }

  private vllmQuantile(series: PromSeries[], base: string): number | null {
    const h = parsePromHistogram(series, base);
    if (h.total === null) return null;
    const q = promHistogramQuantile(h.buckets, h.total, 0.95);
    return q === null ? null : round2(q * 1000);
  }

  private async applyVllmMetrics(): Promise<LlmMetrics> {
    const res = await this.getText("/metrics");
    if (res === null) return {};
    const series = parsePromText(res.text);
    const out: LlmMetrics = {};

    const gen = promSum(series, "vllm:generation_tokens_total");
    const genS = this.sample("vllm:gen", gen);
    if (genS !== null) out.decodeTps = genS.rate;

    // Cumulative token counters (M7 ledger). promSum returns the counter's
    // current value; null when this vLLM build does not publish the metric.
    const promptCounter = promSum(series, "vllm:prompt_tokens_total");
    const cacheHits = promSum(series, "vllm:gpu_prefix_cache_hits_total");
    if (gen !== null || promptCounter !== null || cacheHits !== null) {
      out.tokens = { generated: gen, prompt: promptCounter, cached: cacheHits };
    }

    // Prefill: Δiteration_tokens_total_sum surplus over decode Δ (spec-decode
    // noise below 50 % of decode Δ is ignored); fallback Δprompt_tokens_total.
    const iterSum = promSum(series, "vllm:iteration_tokens_total_sum");
    if (iterSum !== null) {
      const iterS = this.sample("vllm:iter", iterSum);
      if (iterS !== null) {
        if (iterS.seeded) {
          out.prefillTps = 0;
        } else if (iterS.dtSec > 0) {
          const dGen = genS !== null && !genS.seeded && genS.dtSec > 0 ? genS.delta : 0;
          let prefillTokens = iterS.delta - Math.max(0, dGen);
          if (dGen > 0 && prefillTokens > 0 && prefillTokens < 0.5 * dGen) prefillTokens = 0;
          out.prefillTps = round2(Math.max(0, prefillTokens / iterS.dtSec));
        }
      }
    } else {
      const promptS = this.sample("vllm:prompt", promptCounter);
      if (promptS !== null) out.prefillTps = promptS.rate;
    }

    out.queueRunning = promSum(series, "vllm:num_requests_running");
    out.queueWaiting = promSum(series, "vllm:num_requests_waiting");
    const kv = promSum(series, "vllm:kv_cache_usage_perc");
    if (kv !== null) out.kvCachePct = round2(kv * 100);
    out.ttftP95Ms = this.vllmQuantile(series, "vllm:time_to_first_token_seconds");
    out.e2eP95Ms = this.vllmQuantile(series, "vllm:e2e_request_latency_seconds");
    out.itlP95Ms = this.vllmQuantile(series, "vllm:inter_token_latency_seconds");
    if (this.contextLength !== null) out.engineMeta = { contextLength: this.contextLength };
    return out;
  }

  private async fetchLlamaProps(): Promise<void> {
    const props = await this.getJson("/props");
    if (props === null || !isObject(props.body)) return;
    const alias = props.body.model_alias;
    if (typeof alias === "string" && alias.length > 0) this.model = alias;
    const ctx = num(props.body.total_context_length);
    if (ctx !== null) this.contextLength = ctx;
  }

  private async applyLlamaCppMetrics(): Promise<LlmMetrics> {
    const out: LlmMetrics = {};
    const slots = await this.getJson("/slots");
    if (slots !== null && Array.isArray(slots.body)) {
      let decoded: number | null = 0;
      let processed: number | null = 0;
      let cached: number | null = 0;
      let active = 0;
      let sawSlot = false;
      for (const slot of slots.body) {
        if (!isObject(slot)) continue;
        sawSlot = true;
        const d = num(slot.n_decoded);
        if (d === null) decoded = null;
        else if (decoded !== null) decoded += d;
        const p = num(slot.n_prompt_tokens_processed);
        if (p === null) processed = null;
        else if (processed !== null) processed += p;
        const c = num(slot.n_prompt_tokens_cached);
        if (c === null) cached = null;
        else if (cached !== null) cached += c;
        if (slot.is_processing === true) active += 1;
      }
      if (sawSlot) {
        const dDec = this.sample("llama:decoded", decoded);
        if (dDec !== null) out.decodeTps = dDec.rate;
        const dProc = this.sample("llama:processed", processed);
        if (dProc !== null) out.prefillTps = dProc.rate;
        out.queueRunning = active;
        if (decoded !== null || processed !== null || cached !== null) {
          out.tokens = { generated: decoded, prompt: processed, cached };
        }
      }
    }
    await this.fetchLlamaProps();
    if (this.contextLength !== null) {
      out.engineMeta = { ...out.engineMeta, contextLength: this.contextLength };
    }
    return out;
  }

  private async fetchSglangInfo(): Promise<{ status: number; body: unknown } | null> {
    const info = await this.getJson("/server_info");
    if (info !== null && isObject(info.body)) return info;
    const legacy = await this.getJson("/get_server_info");
    return legacy !== null && isObject(legacy.body) ? legacy : null;
  }

  /** Sticky gauge: live only after an observed change; expires to 0. */
  private sglangStickyThroughput(raw: number | null, inflight: boolean): number | null {
    if (raw === null || !Number.isFinite(raw) || raw < 0) {
      this.sglangSticky = null;
      return null;
    }
    const rounded = round2(raw);
    const now = this.now();
    const prev = this.sglangSticky;
    if (prev === null) {
      this.sglangSticky = {
        value: rounded,
        liveUntil: inflight && rounded > 0 ? now + SGLANG_STICKY_TTL_MS : 0,
      };
      return inflight && rounded > 0 ? rounded : 0;
    }
    if (rounded !== prev.value) {
      this.sglangSticky = { value: rounded, liveUntil: now + SGLANG_STICKY_TTL_MS };
      return rounded;
    }
    if (prev.liveUntil > now) return rounded;
    if (inflight && rounded > 0) return rounded;
    return 0;
  }

  private async applySglangMetrics(): Promise<LlmMetrics> {
    const out: LlmMetrics = {};
    const engineMeta: Record<string, unknown> = {};

    // 1. /v1/loads — running/waiting requests.
    let running: number | null = null;
    let waiting: number | null = null;
    const loads = await this.getJson("/v1/loads");
    if (loads !== null && isObject(loads.body) && Array.isArray(loads.body.loads)) {
      running = 0;
      waiting = 0;
      for (const row of loads.body.loads) {
        if (!isObject(row)) continue;
        const r = num(row.num_running_reqs);
        const w = num(row.num_waiting_reqs);
        if (r !== null) running += r;
        if (w !== null) waiting += w;
      }
    }

    // 2. /metrics — counter diffs + prefill split. Each window is ticked at
    //    most once per probe, so the server_info fallbacks below stay valid.
    let genSampled = false;
    let prefillSampled = false;
    // IRI-071: cumulative counters feed the M7 ledger (prompt = prefill
    // compute + cache; cached = the cache subset). Reset-safe: the ledger
    // drops non-monotonic samples.
    let genCounter: number | null = null;
    let promptCounter: number | null = null;
    let cachedCounter: number | null = null;
    const metricsText = await this.getText("/metrics");
    if (metricsText !== null) {
      const series = parsePromText(metricsText.text);
      const gen = promSum(series, "sglang:generation_tokens_total");
      if (gen !== null) {
        genSampled = true;
        genCounter = gen;
        const genS = this.sample("sglang:gen", gen);
        if (genS !== null) out.decodeTps = genS.rate;
      }
      const compute = promLabeledSum(
        series,
        "sglang:realtime_tokens_total",
        (l) => l.mode === "prefill_compute",
      );
      const cache = promLabeledSum(
        series,
        "sglang:realtime_tokens_total",
        (l) => l.mode === "prefill_cache",
      );
      if (compute !== null) {
        prefillSampled = true;
        promptCounter = compute + (cache ?? 0);
        cachedCounter = cache;
        const computeS = this.sample("sglang:prefill_compute", compute);
        if (computeS !== null) out.prefillTps = computeS.rate;
      }
      if (running === null) running = promSum(series, "sglang:num_running_reqs");
    }

    // 3. /server_info — KV budget, model path, total_* counter fallbacks and
    //    the sticky last_gen_throughput gauge (metrics are often off).
    const info = await this.fetchSglangInfo();
    let stickyRaw: number | null = null;
    if (info !== null && isObject(info.body)) {
      const body = info.body;
      const ctx = num(body.context_length);
      const kvBudget = num(body.max_total_num_tokens);
      const maxRunning = num(body.max_running_requests);
      if (ctx !== null) {
        engineMeta.contextLength = ctx;
        if (this.contextLength === null) this.contextLength = ctx;
      }
      if (kvBudget !== null) engineMeta.kvPoolTokens = kvBudget;
      if (maxRunning !== null) engineMeta.maxRunningRequests = maxRunning;
      const modelPath = body.model_path;
      if (this.model === null && typeof modelPath === "string") {
        this.model = normalizeModelId(modelPath);
      }
      if (!genSampled) {
        const totalOut = num(body.total_output_tokens);
        if (totalOut !== null) {
          genCounter = totalOut;
          const totalS = this.sample("sglang:gen", totalOut);
          if (totalS !== null) out.decodeTps = totalS.rate;
        }
      }
      if (!prefillSampled) {
        const totalIn = num(body.total_input_tokens);
        if (totalIn !== null) {
          promptCounter = totalIn;
          const totalInS = this.sample("sglang:prefill_compute", totalIn);
          if (totalInS !== null) out.prefillTps = totalInS.rate;
        }
      }
      if (Array.isArray(body.internal_states)) {
        for (const st of body.internal_states) {
          if (!isObject(st)) continue;
          const t = num(st.last_gen_throughput);
          if (t !== null && (stickyRaw === null || t > stickyRaw)) stickyRaw = t;
        }
      }
      if (stickyRaw !== null) engineMeta.lastGenThroughput = stickyRaw;
    }

    // 4. Sticky gauge drives decode whenever the counter path has no live rate.
    const inflight = (running ?? 0) > 0 || (waiting ?? 0) > 0;
    if (stickyRaw !== null) {
      const sticky = this.sglangStickyThroughput(stickyRaw, inflight);
      if (out.decodeTps === undefined || out.decodeTps === null || out.decodeTps === 0) {
        out.decodeTps = sticky ?? 0;
      }
    }

    if (running !== null) out.queueRunning = running;
    if (waiting !== null) out.queueWaiting = waiting;
    // IRI-071: cumulative counters feed the M7 ledger — nulls pass through so
    // coverage (not a zero guess) is recorded when a counter is absent.
    if (genCounter !== null || promptCounter !== null) {
      out.tokens = { generated: genCounter, prompt: promptCounter, cached: cachedCounter };
    }
    if (Object.keys(engineMeta).length > 0) out.engineMeta = engineMeta;
    return out;
  }

  private async applyExl3Health(): Promise<LlmMetrics> {
    const res = await this.getJson("/health");
    if (res === null || !isObject(res.body)) return {};
    const body = res.body;
    const out: LlmMetrics = {};
    const busy = body.busy === true;
    const promptCounter = num(body.prompt_tokens_total);
    const completionCounter = num(body.completion_tokens_total);
    const promptS = this.sample("exl3:prompt", promptCounter);
    if (promptS !== null) out.prefillTps = busy ? promptS.rate : 0;
    const completionS = this.sample("exl3:gen", completionCounter);
    if (completionS !== null) out.decodeTps = busy ? completionS.rate : 0;
    // Cumulative counters feed the M7 ledger (IRI-054); exl3 /health has no
    // cached counter, so cached stays null — the ledger never guesses a zero.
    if (promptCounter !== null || completionCounter !== null) {
      out.tokens = { generated: completionCounter, prompt: promptCounter, cached: null };
    }
    out.queueRunning = busy ? 1 : 0;
    const engineMeta: Record<string, unknown> = { busy };
    const ctx = num(body.context_length);
    if (ctx !== null) {
      engineMeta.contextLength = ctx;
      if (this.contextLength === null) this.contextLength = ctx;
    }
    out.engineMeta = engineMeta;
    return out;
  }

  private async applyTensorFoldHealth(): Promise<LlmMetrics> {
    const res = await this.getJson("/health");
    if (res === null || !isObject(res.body)) return {};
    const body = res.body;
    const out: LlmMetrics = {};
    const engineMeta: Record<string, unknown> = {};

    // Counter windows are sampled on every probe — when a build starts or
    // stops publishing live{}, the counter-diff path keeps a continuous dt.
    const promptS = this.sample("tf:prompt", num(body.prompt_tokens_total));
    const cachedS = this.sample("tf:cached", num(body.cached_tokens_total) ?? 0);
    const prefillSecondsS = this.sample("tf:prefill_seconds", num(body.prefill_seconds_total));
    const completionS = this.sample("tf:gen", num(body.completion_tokens_total));

    const live = isObject(body.live) ? body.live : null;
    const liveDecode = live === null ? null : num(live.decode_tokens_per_second);
    const livePrefill = live === null ? null : num(live.prefill_tokens_per_second);

    if (liveDecode !== null) {
      out.decodeTps = liveDecode;
    } else if (completionS !== null) {
      out.decodeTps = completionS.rate;
    }

    if (livePrefill !== null) {
      out.prefillTps = livePrefill;
    } else if (promptS !== null) {
      if (promptS.seeded) {
        out.prefillTps = 0;
      } else if (promptS.dtSec > 0) {
        // Prefill EXCLUDES cached tokens — a 95 % cache turn would otherwise
        // show an absurd tok/s (brief: Δcomputed ÷ Δprefill_seconds_total).
        const cachedValid = cachedS !== null && !cachedS.seeded && cachedS.dtSec > 0;
        const computed = cachedValid
          ? Math.max(0, promptS.delta - cachedS.delta)
          : Math.max(0, promptS.delta);
        if (
          prefillSecondsS !== null &&
          !prefillSecondsS.seeded &&
          prefillSecondsS.dtSec > 0 &&
          prefillSecondsS.delta > 0
        ) {
          out.prefillTps = round2(computed / prefillSecondsS.delta);
        } else {
          out.prefillTps = round2(computed / promptS.dtSec);
        }
      }
    }

    const hasCounters =
      num(body.prompt_tokens_total) !== null || num(body.completion_tokens_total) !== null;
    // Cumulative counters feed the M7 ledger (IRI-054); nulls pass through and
    // the ledger records coverage instead of guessing a zero.
    if (hasCounters) {
      out.tokens = {
        generated: num(body.completion_tokens_total),
        prompt: num(body.prompt_tokens_total),
        cached: num(body.cached_tokens_total),
      };
    }
    if (!hasCounters && live === null) {
      // /metrics fallback for builds without health counters/live block.
      const m = await this.getText("/metrics");
      if (m !== null) {
        const series = parsePromText(m.text);
        if (out.decodeTps === undefined) {
          const genS = this.sample("tf:gen", promSum(series, "tensorfold:generation_tokens_total"));
          if (genS !== null) out.decodeTps = genS.rate;
        }
        if (out.prefillTps === undefined) {
          const promptS = this.sample("tf:prompt", promSum(series, "tensorfold:prompt_tokens_total"));
          if (promptS !== null) out.prefillTps = promptS.rate;
        }
        // Native builds publish the same counters in the tensorfold: family;
        // no cached counter exists there.
        const genCounter = promSum(series, "tensorfold:generation_tokens_total");
        const promptCounter = promSum(series, "tensorfold:prompt_tokens_total");
        if (genCounter !== null || promptCounter !== null) {
          out.tokens = { generated: genCounter, prompt: promptCounter, cached: null };
        }
      }
    }

    const running = num(body.requests_running);
    if (running !== null) out.queueRunning = running;
    const liveWaiting = live === null ? null : num(live.waiting);
    if (liveWaiting !== null) out.queueWaiting = liveWaiting;

    const pool = num(body.pool_tokens);
    const free = num(body.pool_free_tokens);
    if (pool !== null && free !== null && pool > 0) {
      out.kvCachePct = round2(Math.min(100, Math.max(0, (1 - free / pool) * 100)));
    }

    // Native builds (1.1+) dropped the health counter/pool block: queue depth
    // and KV live only in /metrics (same tensorfold: family as the classic
    // health fields the branches above consume).
    if (running === null || out.kvCachePct === undefined || out.tokens === undefined) {
      const m = await this.getText("/metrics");
      if (m !== null) {
        const series = parsePromText(m.text);
        if (running === null) {
          const queue = promSum(series, "tensorfold:requests_running");
          if (queue !== null) out.queueRunning = queue;
        }
        if (out.kvCachePct === undefined) {
          const kv = promSum(series, "tensorfold:kv_cache_usage_ratio");
          if (kv !== null) out.kvCachePct = round2(Math.min(100, Math.max(0, kv * 100)));
        }
        // A live{} block without health counters still skips the counter
        // fallback above; the tensorfold: family is the only token source
        // for these builds (no cached counter exists there).
        if (out.tokens === undefined) {
          const genCounter = promSum(series, "tensorfold:generation_tokens_total");
          const promptCounter = promSum(series, "tensorfold:prompt_tokens_total");
          if (genCounter !== null || promptCounter !== null) {
            out.tokens = { generated: genCounter, prompt: promptCounter, cached: null };
          }
        }
      }
    }

    if (live !== null) engineMeta.live = live;
    if (isObject(body.streams)) engineMeta.streams = body.streams;
    if (pool !== null) engineMeta.poolTokens = pool;
    if (free !== null) engineMeta.poolFreeTokens = free;
    const ctx = num(body.context_length);
    if (ctx !== null) {
      engineMeta.contextLength = ctx;
      if (this.contextLength === null) this.contextLength = ctx;
    }
    if (Object.keys(engineMeta).length > 0) out.engineMeta = engineMeta;
    return out;
  }

  private async applyQ27Metrics(): Promise<LlmMetrics> {
    const res = await this.getText("/metrics");
    if (res === null) return {};
    const series = parsePromText(res.text);
    const out: LlmMetrics = {};

    const decodeS = this.sample(
      "q27:gen",
      promSum(series, "q27_decode_tokens_processed_total") ??
        promSum(series, "q27_decode_tokens_total"),
    );
    if (decodeS !== null) out.decodeTps = decodeS.rate;
    const decodeCounter = promSum(series, "q27_decode_tokens_processed_total") ?? promSum(series, "q27_decode_tokens_total");
    const prefillCounter =
      promSum(series, "q27_prefill_computed_tokens_processed_total") ?? promSum(series, "q27_prefill_computed_tokens_total");
    if (decodeCounter !== null || prefillCounter !== null) {
      out.tokens = { generated: decodeCounter, prompt: prefillCounter, cached: null };
    }
    const computeS = this.sample(
      "q27:prefill",
      prefillCounter,
    );
    if (computeS !== null) out.prefillTps = computeS.rate;

    out.queueRunning = promSum(series, "q27_requests_inflight");
    const kv = promSum(series, "q27_kv_usage_perc");
    if (kv !== null) out.kvCachePct = round2(kv * 100);
    out.ttftP95Ms = this.vllmQuantile(series, "q27_ttft_seconds");
    out.e2eP95Ms = this.vllmQuantile(series, "q27_e2e_seconds");
    out.itlP95Ms = this.vllmQuantile(series, "q27_itl_seconds");

    const engineMeta: Record<string, unknown> = {};
    const slots = promSum(series, "q27_slots_total");
    if (slots !== null) engineMeta.slotsTotal = slots;
    const spec = promMax(series, "q27_spec_accept_ratio");
    if (spec !== null) engineMeta.specAcceptRatio = spec;
    if (Object.keys(engineMeta).length > 0) out.engineMeta = engineMeta;
    return out;
  }

  private async applyDs4Metrics(): Promise<LlmMetrics> {
    const res = await this.getText("/metrics");
    if (res === null) return {};
    const series = parsePromText(res.text);
    const out: LlmMetrics = {};

    // Cumulative counters are the live source; the *_tok_s gauges are ~60 s
    // windows and are used only when the counters are absent.
    const decodeCounter = promSum(series, "ds4_tokens_decoded_total");
    const decodeS = this.sample("ds4:gen", decodeCounter);
    if (decodeS !== null) {
      out.decodeTps = decodeS.rate;
    } else {
      const gauge = promMax(series, "ds4_decode_tok_s");
      if (gauge !== null) out.decodeTps = round2(gauge);
    }
    const prefillCounter = promLabeledSum(series, "ds4_tokens_prefilled_total", (l) => l.kind === "computed");
    if (decodeCounter !== null || prefillCounter !== null) {
      out.tokens = { generated: decodeCounter, prompt: prefillCounter, cached: null };
    }
    const computeS = this.sample("ds4:prefill", prefillCounter);
    if (computeS !== null) {
      out.prefillTps = computeS.rate;
    } else {
      const gauge = promMax(series, "ds4_prefill_tok_s");
      if (gauge !== null) out.prefillTps = round2(gauge);
    }

    out.queueRunning = promSum(series, "ds4_requests_inflight");
    const engineMeta: Record<string, unknown> = {};
    if (this.contextLength !== null) engineMeta.contextLength = this.contextLength;
    const banks = promSum(series, "ds4_banks_total");
    if (banks !== null) engineMeta.banksTotal = banks;
    const spec = promMax(series, "ds4_spec_accept_ratio");
    if (spec !== null) engineMeta.specAcceptRatio = spec;
    if (Object.keys(engineMeta).length > 0) out.engineMeta = engineMeta;
    return out;
  }
}
