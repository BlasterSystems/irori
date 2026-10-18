# Task: IRI-007 — M6 Benchmarks

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M6)

## Objective

Four benchmarks running via the agent against live engines: decode, prefill,
quality, tool-eval — with persisted results, history, and comparison.

## Acceptance criteria

- [ ] Decode: multi-concurrency streaming tok/s; task types structured/prose/
      code/json; lab protocol (temp 0, thinking off); live tok/s from the run's
      own streams.
- [ ] Prefill: context sweep 1k–300k, prefill tok/s + TTFT, unique prefix per
      size.
- [ ] Quality: seeded suite (QA, reasoning, arithmetic, state tracking, GSM8K,
      MMLU) at temp 0; per-category + overall; paired compare with McNemar p.
- [ ] Tool-eval: agentic tool-use trials; side-by-side compare.
- [ ] Run lifecycle: 202 start + poll/cancel; results persisted; history
      views; target = live engine via agent (LAN, SSH tunnel, or on-demand
      host:port).

## Scope

### Included

- `POST /api/v1/bench/{decode,prefill,quality,tooleval}`, run records in db.

### Excluded

- VulnHunter/REA (dropped); share-as-image cards (deferred).

## Plan

- [x] Research brief: bench protocols from sparkDash/sparkControl
      (`LlmProbe`, bench engines) — reuse request shapes, not code.
      → [docs/research/IRI-007-research-brief.md](../docs/research/IRI-007-research-brief.md)
- [x] Agent bench runners → run records → results API → UI.

## Implementation notes (2026-10-18)

- **Contracts** (`packages/core/src/bench.ts`): per-bench config/result
  schemas + `bench-run`/`bench-cancel` (server→agent) and
  `bench-progress`/`bench-done` (agent→server) frames, `mcnemarExactP`,
  `compareQualityRuns`, `decodeBestLevel`, size/concurrency normalizers.
- **DB**: `bench_runs` (migration 0007) — type/node/status/config/result,
  pruned to the last 30 per type by the retention loop.
- **Agent** (`apps/agent/src/bench/`): undici streaming core (no 300 s header
  cut), decode waves (temp 0 / top_p 1 / thinking off / `min_tokens`+
  `ignore_eos` with strip-fallback, 32-token warmup, per-stream
  (completion−1)/(last−first) tok/s, aggregate over the concurrent window,
  live tok/s from the run's own streams via a 2 s rolling window), prefill
  sweep (fresh salt per request, repeats 3/2/1 by size, server `timings` else
  TTFT − calibrated overhead capped 50%, low-confidence flag at 30%),
  seeded quality suite (mulberry32/FNV-1a, SUITE_VERSION/SCORING_VERSION 1,
  `seed: 1234`, think-strip + negation-aware scoring, GSM8K/MMLU MIT fixtures
  with NOTICE) and 20 deterministic tool-eval trials (selection/params/
  multistep/safety/negative, simulated tools, bounded turns). One active
  bench per agent; progress throttled to 1/s.
- **Server**: `bench-service.ts` (202 start + 409 busy/offline, agent frame
  correlation, zod-validated results, offline reaper, 30/type prune), routes
  per SPEC §14, hub routing, SSE `bench` events.
- **Web**: Benchmarks view (tabs, per-bench run forms, live progress chips,
  history per type, compare: decode/prefill level tables, quality per-category
  + exact McNemar + pooled verdict, tooleval side-by-side).
- **Out of scope (per task)**: VulnHunter/REA, share-as-image cards.
- **Known limits**: quality `byCategory` is always exhaustive over all six
  categories (schema-valid regardless of selection); tooleval `error` is
  request-level only (a scored miss is `pass: false, error: null`); bench
  targets are arbitrary `host:port` reachable by the agent (LAN / on-demand) —
  the SSH-tunnel transport variant stays deferred (same as M3's note).

## Architecture impact

- **ADR required:** No.
- **Relevant ADRs:** 0003 (runs via agent), 0006 (event stream).
- **Proposed ADR:** None.

## Validation evidence

- 2026-10-18: `pnpm test` — core 46/46 (incl. McNemar/compare/contracts),
  agent 109/109 (incl. decode/prefill/tooleval runners against a local SSE
  fixture engine + scoring + BenchRunner busy/cancel), server 76/76 against
  a disposable Postgres (incl. bench-service start/busy/complete/cancel/
  reap/prune), web 110/110 (incl. BenchmarksView DS guard + shaping helpers).
- 2026-10-18: `pnpm build` green; `.agentic/bin/validate` green.
- 2026-10-18: live full-stack e2e (throwaway script, not committed): fixture
  engine on :8091 + server + real agent bundle over WS — all four benches
  dispatched, ran, and persisted (`completed`), history queryable per type;
  offline dispatch → 409 + failed row; invalid config → 400; unknown type →
  404; routes match SPEC §14.
- Residual: docs-check notes heuristic warnings (schema migration changed
  without ADR — SPEC §8/§14 already cover the feature; ADR-0002/0003/0006
  unchanged).

## Review

- (pending)
