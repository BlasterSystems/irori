# IRI-004 research brief — per-backend LLM probe endpoints & conventions

- **Date:** 2026-10-17
- **Ticket:** IRI-004 (M3) — Jira [IR-21](https://blastersystems.atlassian.net/browse/IR-21) (IR-22 probes, IR-23 head card/cluster)
- **Goal:** How does each backend self-identify, and which endpoints publish model/queue/KV/latency data?

> Full per-backend research (with verbatim fixtures) was extracted from
> sparkControl/sparkDash production probe code + their test fixtures;
> fixture bodies live in `~/Developer/sparkControl/server/collectors/__tests__/LlmProbe.*.test.js`
> and are reproduced in `apps/agent/test/llm-probe.test.ts`.

## Detection order (proven, sparkControl `_detectServerType` LlmProbe.js:315)

1. `GET /slots` → JSON **array** → **llama.cpp** (also on 401/403); checked before `/v1/models`, never called again once classified.
2. `GET /v1/models` → 200/401 → OpenAI-compatible; classify by `data[0].owned_by` regex: `ds4|sglang|exl3|q27|tensorfold` → same-name backend; `^ollama$` → ollama. **LM Studio probe first** (`GET /api/v0/models`, 8 s budget — it answers 200 JSON on *every* path); **Ollama probe second** (`GET /api/tags` → top-level `models` array).
3. Fall-through probes: `/metrics` contains `ds4_tokens_decoded_total` → ds4; `/server_info` JSON (with a known sglang field) → sglang; `/health` `{backend:"exl3"}` or `{ok,busy}` → exl3; `/metrics` matches `q27_(decode_tokens_(processed_)?total|requests_total)` → q27; else **vllm**.

## Metrics per backend (endpoints + series names)

| Backend | Endpoints | Key series/fields |
|---|---|---|
| vLLM | `/v1/models`, `/metrics` | `vllm:prompt_tokens_total`, `vllm:generation_tokens_total` (Δ→tok/s), `vllm:num_requests_running/waiting`, `vllm:kv_cache_usage_perc` (0..1), TTFT hist `vllm:time_to_first_token_seconds_{bucket,sum,count}` → p95 (reject quantile if `+Inf` ≠ `_count`), `vllm:e2e_request_latency_seconds`, `vllm:inter_token_latency_seconds`, prefill from `vllm:iteration_tokens_total_sum` (surplus over decode Δ) |
| llama.cpp | `/slots`, `/props` | per-slot `n_decoded`, `n_prompt_tokens_processed/cache`, `is_processing`; `/props` `model_alias`, `total_context_length` |
| SGLang | `/server_info` (or `/get_server_info`), `/v1/loads` (`/get_load`), `/metrics`, `/model_info` | server_info `context_length`, `max_total_num_tokens` (KV budget ≠ ctx), `max_running_requests`, `total_input/output_tokens`; load `num_running_reqs/waiting_reqs`, `gen_throughput`; metrics `sglang:`/`sglang_` — `generation_tokens_total`, `num_running_reqs`, `gen_throughput` (**max not sum** — TP ranks), prefill split `realtime_tokens_total{mode=prefill_compute|prefill_cache}`, `cached_tokens_total{cache_source=device}`; `last_gen_throughput` gauge is sticky → change-gated, 6 s expiry |
| EXL3 | `/health` only | `{ok, busy, backend, prompt_tokens_total, completion_tokens_total, context_length}` — no Prometheus |
| TensorFold | `/v1/models`, `/health`, `/metrics` (only if health lacks totals/live) | health: counters + `cached_tokens_total`, `prefill_seconds_total`, CUDA 0.6+: `streams{decoding,prefilling,filling,paused,max}`, `pool_tokens`/`pool_free_tokens` (KV fill = 1−free/pool), `requests_running`, **`live{decode_tokens_per_second, prefill_tokens_per_second, connections, waiting}`** (server-computed, used as-is); metrics `tensorfold:prompt/generation_tokens_total`, `generation_tokens_running`, `requests_running/waiting`, `mtp_*` |
| q27 | `/metrics` | `q27_decode_tokens_(processed_)?total` (live preferred), `q27_prefill_computed_tokens_(processed_)?total` + cached, `q27_requests_inflight`, `q27_slots_total`, `q27_kv_usage_perc`, hists `q27_ttft/e2e/itl_seconds` |
| ds4 | `/metrics`, `/v1/models` | `ds4_tokens_decoded_total`, `ds4_tokens_prefilled_total{kind=computed|cached}`, window gauges `ds4_decode_tok_s`/`prefill_tok_s` (**fallback only, never live panel**), `ds4_requests_inflight`, `ds4_banks_total`; ctx from `/v1/models` `data[0].context_length` |
| LM Studio | `/api/v0/models` | model list only; no metrics |
| Ollama | `/api/tags` | detection only |
| FreeToken [SD] | `/v1/stats` | `throughput.decode_tps/prefill_tps` (5 s window, as-is), `requests.active`, `ttft_mean_ms`, `p95_ms` (**E2E**, not TTFT) |

## Conventions (binding for the Irori probe)

- **tok/s = cumulative-counter diffs over the poll window** (idle → 0); window guards `0 < dt < 10 s`. Exceptions: SGLang sticky gauge (change-gated), TensorFold/FreeToken `live` blocks (server-computed, as-is).
- Prometheus parsing: sum across label sets; `_getPromMetricMax` for TP-rank gauges; histogram quantiles require `+Inf == _count`.
- Prefill EXCLUDES cached tokens (TensorFold: Δcomputed ÷ Δ`prefill_seconds_total` — a 95 %-cache turn would otherwise show 49 k tok/s).
- Auth: per-port API key map → `Authorization: Bearer`; open/protected detected from status on the unauthenticated request.
- Multi-port: one probe instance per port, independent detection + counters; ports hot-addable.
- **Cadence:** heads/standalone full probes **2 s**; workers **detection-only 10 s**; re-detect every 60 s; 3 consecutive failures reset detection; 3 s HTTP timeout.
- Local nodes probe `127.0.0.1` (ds4 binds loopback). Irori adds `IRORI_LLM_TARGETS` override for tests/remote.

## Irori mapping

- `llmPortSnapshotSchema` (packages/core): backend, detected, model, decodeTps, prefillTps, queueRunning/Waiting, kvCachePct, ttftP95Ms, e2eP95Ms, itlP95Ms, engineMeta (TensorFold live/streams verbatim).
- Detection-only mode (workers): skip rate windows, emit backend/model/detected only.
- Real soak target: **dgx1.lan:8081 — TensorFold CUDA 0.6+ on GLM-5.3-Flash-EXL3** (the `live{}` block + `streams` apply).

## Summary of findings

- Detection + metrics fully specified from production probes; no new protocols needed.
- Irori contract: one `llmMsg` per node per cadence; server stores raw + buckets, serves `/api/v1/nodes/:id/llm` + history.
- Cluster resolution: role-based grouping for M3 (heads anchor the view); recipe-declared clusters land with M5.
