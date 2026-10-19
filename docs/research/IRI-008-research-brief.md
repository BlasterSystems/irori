# IRI-008 research brief — M7 Analytics & packaging

Written 2026-10-19 (post-implementation consolidation — see the Process note at
the end). Sources: live verification on dgx1 (10.0.10.4), NVIDIA DGX Spark
documentation, modelctl 0.20.x CLI.

## Questions and answers

### Q1 — Where does modelctl staging live, and what is cleanable?

`modelctl staging-audit --json --root <root>` (verified on dgx1, agent
container) returns `[{path, status, bytes, name, detail}]` with statuses
`orphaned | journal_referenced | resumable | failed | published duplicates`.
Staging data lives under `<root>/.staging/<org>/<repo>/<hash>--<hash>`.
**Non-resumable only** is cleanable per SPEC §11.6: `resumable` and
`journal_referenced` entries belong to in-flight updates and are protected;
`cleanup-staging <paths...> --apply --root` removes explicitly selected
targets. Live finding: the NAS held ~500 GB of staging junk
(202 GB + 28 GB orphaned, 220 GB journal-referenced).

### Q2 — What modelctl state must the protected set exclude?

- Registered HF-cache entries: `modelctl list --local --json` →
  `[{name, runtime, repository}]`; each entry's cache path resolves via
  `modelctl path --local <name>` (the M4 push-precondition knowledge).
- Active objects: `objects-audit --json` (out of M7 hygiene scope —
  `gc-objects` remains a manual job).

### Q3 — What token counters do the engines publish?

Per-backend, verified against the probe code + IRI-004 semantics:

| Backend | Generated | Prompt (prefill) | Cached |
|---|---|---|---|
| vLLM | `vllm:generation_tokens_total` | `vllm:prompt_tokens_total` | `vllm:gpu_prefix_cache_hits_total` (newer builds only) |
| llama.cpp | `/slots` `n_decoded` sum | `/slots` `n_prompt_tokens_processed` sum | `/slots` `n_prompt_tokens_cached` sum |
| q27 | `q27_decode_tokens_(processed_)total` | `q27_prefill_computed_tokens_(processed_)total` | — |
| ds4 | `ds4_tokens_decoded_total` | `ds4_tokens_prefilled_total{kind="computed"}` | — |
| sglang / exl3 / tensorfold / ollama / lmstudio | gauges only — no cumulative counters → ledger coverage NULL | | |

Counters are CUMULATIVE; the server diffs them per (node, port) with
reset-safety (engine restart decreases the counter → re-baseline, no negative
tokens). Delta bookkeeping is exactly-once via a transactional
(state + ledger rows) commit per batch.

### Q4 — What is the GB10 power envelope for the estimator?

NVIDIA DGX Spark documentation + NVIDIA developer forum (staff-answered):
**GB10 SOC TDP = 140 W (GPU+CPU)**, **100 W budget for other components**
(CX-7, SSD, Wi-Fi, USB), **240 W peak total system power** (240 W USB-PD
adapter). Idle whole-system measured ≈ 31.5 W headless (forum, 2026-10).
Estimator: gpu board + cpu package (RAPL) + 40 W base overhead, clamped to
240 W per hour bucket before integration; base applies only over reporting
buckets (offline time invents no energy).

### Q5 — Which rollup data already supports the lenses?

`snapshot_buckets` (M2) already carries min/avg/max temps, package_power_w,
gpu_power_w, memory, gpu memory, net — minute/hour/day. Retention: minute 7 d
(matches SPEC §9 temps), hour 90 d, day 365 d. The llm buckets (M3) carry
per-port decode/prefill tok/s + queue/KV. Missing at M7 start: token counters
(probe), ledger/energy/cleanup tables, throttle flag (added as
`snapshot_buckets.gpu_throttled`).

## Decisions taken

- Ledger attribution: (node, port, detected model) — "unknown" while
  undetected; the ledger never guesses zeros (coverage columns).
- Energy: documented constants (above) in SPEC §9 + core; per-node
  base-overhead config deferred (single global default is enough for a
  homogeneous GB10 fleet).
- Hygiene docker categories degrade gracefully without the docker CLI
  (containerized agents without the socket report "not available"; bare-metal
  primary install has docker).

## Process note

This brief was written AFTER implementation (during the process audit) — the
unknowns above were settled live during the build (dgx1 CLI probes, web
search) without the research skill's brief-first step. The evidence and
decisions are consolidated here so the record is complete; next milestones
should write the brief BEFORE planning (DEVELOPMENT_PROCESS §2).
