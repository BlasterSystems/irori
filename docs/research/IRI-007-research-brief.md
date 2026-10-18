# IRI-007 research brief — M6 benchmark protocols

- **Date:** 2026-10-18
- **Ticket:** IRI-007
- **Goal:** The four Irori benches run in the agent against OpenAI-compatible
  engines. What exactly do the proven sparkDash/sparkControl engines measure,
  which request shapes do they send, and how do they compute rates/scores —
  so Irori reuses the protocols (not the code)?

All evidence below is from the local primary sources
(`~/Developer/sparkDash`, `~/Developer/sparkControl`).

## 1. Decode bench (sparkDash `server/collectors/DecodeBench.js`)

**Header comment** (lines 1–15): "Measures real post-first-token decode tok/s
against an OpenAI-compatible chat completions endpoint. Concurrency levels run
one after another. Output types (structured / prose / code / json) are prompt
labels only — never response_format, grammars, or guided JSON. Structured
protocol (matches glm-5.3-flash-sm120 tests/bench_decode.py): count 1→200,
temperature 0, top_p 1, thinking off, warmup 32 tokens, decode tok/s =
(completion_tokens − 1) / (last − first token)."

- Levels: `ALLOWED_CONCURRENCIES = {1,2,3,4,5,6,8,10,12,16,24,32}`
  (line 62); waves run sequentially, `DEFAULT_MAX_TOKENS = 400` (bounds
  64–2048), `WARMUP_MAX_TOKENS = 32`, per-request timeout 360 s, wave timeout
  360 s.
- Request body (`decodeRequestBody`, line 116): `{ model, messages:
  [{role:"user", content: prompt}], max_tokens, temperature: 0, top_p: 1,
  stream: true, stream_options: { include_usage: true } }` + thinking-off
  flags (`applyThinkingFlags`); waves add `min_tokens: maxTokens,
  ignore_eos: true, stop: []` and **fall back to `stripFillForceFields`**
  (drops vLLM-only fields) on HTTP 400 (line 390).
- Warmup: one 32-token stream first so Triton JIT / DFlash2 is not billed to
  the first wave; failure is non-fatal (line 128).
- Per-stream rate: `(completion_tokens − 1) / (tLast − tFirst)` — first
  visible token to last visible token, **not** stream EOF, so trailing
  usage/[DONE] latency does not drag the rate (LlmStreaming.js header).
- Aggregate: "Client aggregate over concurrent first→last content window"
  — total decode tokens / (`max(tLast) − min(tFirst)`), plus
  mean/median/min/max per-stream tok/s and mean TTFT (line ~420).
- Live tok/s: `createLiveRate` (line ~347) — tokens received across all
  streams over a rolling 2 s window sampled every 1 s; "the engine's own live
  reading is 0 on backends whose counters only move when a request finishes
  (TensorFold and EXL3 /health totals)" → measure from the run's own streams.
- Prompts (sparkDash `src/shared/llmPrompts.js`): one base prompt per type
  (structured = count 1→200, prose = prose generation, json = JSON object,
  code = a Python function); **unique prompts per stream** ("so the prompts do
  not share a prefix-cache block. Same language and similar length so a
  concurrency sweep compares batching, not unrelated workloads"); code tasks
  are distinct per stream (C1 = warmup).
- Thinking off: `applyThinkingFlags(body, modelId, false)` sets
  `chat_template_kwargs: { enable_thinking: false, thinking: false,
  thinking_mode: "disabled" }` + `thinking: { type: "disabled" }`
  (LlmStreaming.js line 323–387); a 400 from a strict server falls back to a
  stripped body.

## 2. Prefill bench (sparkDash `server/collectors/PrefillBench.js`)

**Header comment** (lines 1–5): "Sends a unique-prefix padded prompt at each
selected size (up to 300k), generates a handful of tokens, and records
prompt_tokens / TTFT. One request per size (concurrency 1) so prefix-cache
from a prior size cannot inflate the next: each request starts with a fresh
salt."

- Sizes: `PREFILL_CONTEXT_SIZES = [1024 … 300000]`, default `[4096, 8192,
  16384, 32768]`, custom 256–300k (shared/prefillBench.js).
- Unique prefix (`buildPrefillPrompt`, line 105): header
  `[prefill-bench {salt}]` (random salt) + filler words drawn from common
  one-token words in a fixed LCG pseudo-random order ("less degenerate than
  one repeated token (attention/MoE routing look closer to real text) while
  the token count stays ~1 per word") + "Reply OK." Footer. Target tokens
  ≈ chars/4 (`estimateTokenCount`).
- Repeats per size (`repeatsForSize`, line 152): ≤32k → 3, ≤128k → 2, else 1.
- Body: `max_tokens: 8` (GEN_MAX_TOKENS), temp 0, top_p 1, stream +
  include_usage, thinking off.
- Rate (`rateFromSample`, line 172):
  - **server**: llama.cpp `timings.prompt_n / prompt_ms` when reported →
    exact server-measured prefill.
  - **ttft**: `(promptTokens − cachedTokens) / (TTFT − calibrated
    overhead)`; overhead from a 3× 16-token calibration (`CALIBRATION_TOKENS
    = 16`, `CALIBRATION_SAMPLES = 3`); correction capped at 50% of TTFT
    (`MAX_OVERHEAD_CORRECTION`), sample flagged `lowConfidence` when the
    overhead exceeds 30% (`LOW_CONFIDENCE_OVERHEAD_SHARE`).
- Cache accounting: `usage.prompt_tokens_details.cached_tokens` excluded from
  computed tokens; fully-cached samples → rate 0 with reason.
- Timeout per size (`timeoutMsForSize`, line 204): 90 s floor + 8 ms/token,
  45 min cap — "256k at a slow ~200 tok/s is ~22 min — the old 12 min cap
  aborted those runs."
- Dispatcher: undici `Agent({ headersTimeout: 0, bodyTimeout: 0 })` because
  "Undici's default headersTimeout/bodyTimeout is 300s. A 256k prefill that
  has not produced a first token by then is aborted" (LlmStreaming.js 17–30).

## 3. Quality bench (sparkDash `server/collectors/QualityBench.js` + `qualitySuite.js`)

**qualitySuite.js header** (lines 1–11): "Every category draws from its own
seeded PRNG (mulberry32), so items and ids are identical on every run and two
runs can be paired item-by-item. Changing one category's generator never
shifts another category's items."

- Suite versioning: `SUITE_VERSION = 1` (item set), `SCORING_VERSION = 2`
  (parsers), `REQUEST_SEED = 1234` sent as `seed` in every request (lines
  17–24) — comparison refuses to pair runs with different versions
  (`checkQualityComparable`, shared/qualityBench.js line 69).
- Categories: `["qa","reason","arith","track","gsm8k","mmlu","follow","long"]`,
  default the first six (shared/qualityBench.js line 8–12). Irori M6 scope =
  QA, reasoning, arithmetic, state tracking, GSM8K, MMLU.
- Items: `{ id, category, prompt, expected/accept, maxTokens, thinking }`;
  thinking is per item (GSM8K `thinking: true` — reasoning allowed — MMLU
  `false`, others false; qualitySuite.js lines 560–585). `max_tokens` per
  category (QA 64, MMLU 1024, GSM8K large for chain-of-thought).
- Data: `data/gsm8k-200.json` — "a fixed 200-problem sample of the GSM8K test
  set. Copyright (c) 2021 OpenAI. MIT License"; `data/mmlu-285.json` — "a
  fixed sample of the MMLU test set (5 questions from each of 57 subjects).
  Copyright (c) 2020 Dan Hendrycks. MIT License" (server/collectors/data/
  NOTICE.md). Row shapes: GSM8K `{n, q, a}`; MMLU `{n, s, q, c[4], a}`.
  Prompt templates: GSM8K — "Solve it step by step. End your reply with a
  line 'Answer: <number>' containing only the final number."; MMLU —
  "The following is a multiple choice question about {subject}. … Reply with
  the letter of the correct answer. End your reply with a line
  'Answer: <letter>'." (lines 556–585).
- Scoring (`qualitySuite.js` 740+): strip `<think>…</think>` spans first
  (`visibleAnswer`); QA modes from the accepted-answer shape — **number** =
  last number in the reply is the answer ("1391" and "391 or 5" fail);
  **word** = whole word in a short reply, negation-aware ("Canberra is
  wrong" fails, "Canberra, not Sydney" passes); **list** = last N integers in
  order. GSM8K: `Answer: <number>` line else last integer. MMLU: last A–D
  letter (parenthesized or bare). Items with request errors are unscored and
  excluded from comparisons.
- Paired compare: exact two-sided McNemar on discordant pairs —
  `mcnemarExactP(b, c)`: "p = min(1, 2 * sum_{i<=min(b,c)} C(b+c, i) /
  2^(b+c))" (shared/qualityBench.js line 38); per-category rows {onlyA,
  onlyB} + pooled overall verdict by summing discordant counts ("The items
  are independent pairs, so summing the discordant counts and running the
  exact two-sided test on the totals is valid" — src/components/SparkPage/
  qualityCompare.ts line 50); p ≥ 0.05 ⇒ "within noise". Comparison requires
  same suite + scoring versions and the same item ids.

## 4. Tool-eval (sparkDash wraps a Python tool; Irori runs trials natively)

- sparkDash does not implement trials in JS — `server/tooleval/spec.js`
  mirrors the CLI of an external `tool-eval-bench` Python tool run on the
  Spark ("69 deterministic scenarios (selection, parameters, multi-step,
  safety)" — src/bench/benchCatalog.ts line 24), streaming JSONL progress
  events (`scenario_start`, `scenario_result {status: pass|partial|fail,
  points}`, `benchmark_complete {final_score}` — ToolEvalManager.js
  `reduceProgress`).
- Irori has no such tool on nodes, so the agent implements **agentic
  tool-use trials** itself: chat-completions with `tools` (function schemas),
  simulated tool execution, bounded turns, deterministic pass/fail checks per
  scenario. The request shape that matters (tools array + tool role messages
  + parallel tool calls in `message.tool_calls`) is the OpenAI-compatible
  convention every local engine already serves for the live probe
  (`/v1/chat/completions`).

## 5. Run lifecycle + persistence in Irori

- SPEC §8: all benches run **via the agent**; SPEC §14 API:
  `POST /api/v1/bench/{decode,prefill,quality,tooleval}`,
  `GET /api/v1/bench/:type/runs`. ADR-0003: long work is agent-driven
  (modelctl jobs pattern); ADR-0006: event stream for live updates. The M5
  setup driver already established the frame pattern: dedicated
  `setup-*` frames with progress + final state — benches mirror that with
  `bench-run`/`bench-progress`/`bench-done`/`bench-cancel` instead of reusing
  the line-oriented `job` channel (results are structured JSON, not logs).
- History: Postgres (`bench_runs`), last 30 runs per type
  (mockups/benchmarks.html: "last 30 runs kept per type · results survive
  restarts (Postgres)"), status chips running/completed/failed/cancelled +
  cancel button on running rows.
- One active bench per node (SPEC §13 "one active job per node"); the server
  answers 409, the agent rejects a second `bench-run`.

## Summary of Findings

1. **Decode**: sequential concurrency waves from {1…32}, lab protocol temp 0
   / top_p 1 / max_tokens 400 / thinking off / `stream_options.include_usage`
   / `min_tokens`+`ignore_eos` with strip-fallback on 400; 32-token warmup;
   per-stream tok/s = (completion_tokens−1)/(last−first token); aggregate =
   tokens / concurrent window; live tok/s from the run's own streams (2 s
   rolling window); unique prompts per stream per type; output types are
   prompt labels only.
2. **Prefill**: sequential sizes ≤300k, unique salted prefix per request
   (fresh salt per repeat), 8 generated tokens, TTFT = first token;
   rate = server `timings` when available else (prompt−cached)/(TTFT −
   calibrated overhead), overhead-capped 50%, low-confidence flag at 30%;
   repeats 3/2/1 by size; per-size timeout 90 s + 8 ms/token (45 min cap);
   undici dispatcher with no header/body timeout.
3. **Quality**: seeded per-category generators (mulberry32 + FNV-1a), suite +
   scoring versions gate comparison, `seed: 1234` in requests, per-item
   thinking flags, deterministic scoring (think-strip, last-number QA,
   negation-aware word mode, MMLU letter, GSM8K Answer: line), paired
   compare = exact McNemar per category + pooled overall.
4. **Tool-eval**: native in-agent trials (no external tool): function-schema
   scenarios across selection/params/multi-step/safety categories, simulated
   execution, bounded turns, per-scenario pass/fail; side-by-side compare is
   per-scenario + aggregate.
5. **Lifecycle**: `bench_runs` in Postgres (30 per type), 202 start +
   poll/cancel via dedicated WS frames, one active bench per node, SSE for
   live progress.

Open: none blocking implementation. Exact item text for the seeded quality
suite is Irori's own (fresh generators); GSM8K/MMLU data ships as MIT
fixtures with NOTICE attribution.
