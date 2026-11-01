# Task: IRI-054 — TensorFold/EXL3 probes emit token counters

Jira **IR-153** (Bug, sprint 990). Independent of IR-154 (capture proxy).

## Objective

The Analytics Tokens lens and the M7 token ledger are permanently empty for
TensorFold and EXL3 engines — the fleet's primary serving backends. The agent
LLM probe computes decode/prefill rates from these engines' cumulative
counters but never emits `tokens` in the snapshot, so the hub ledger has
nothing to diff and skips the port.

## Acceptance criteria

- [x] A running TensorFold setup produces llm snapshots with non-null tokens;
      after two probe passes the token ledger contains rows for its model.
- [x] The Analytics tokens lens shows non-zero totals without any other change.
- [x] EXL3 emits generated/prompt with `cached: null` (no cached counter in
      its /health) — coverage recorded, never a guessed zero.

## Scope

### Included

- `apps/agent/src/llm-probe.ts`: emit `out.tokens` in `applyTensorFoldHealth`
  (health counters `completion/prompt/cached_tokens_total`; /metrics fallback
  from the `tensorfold:` family) and `applyExl3Health`
  (`completion/prompt_tokens_total`, cached null).
- Probe tests: tokens in the EXL3 and TensorFold classic snapshots; the
  native-build (live{}-only) path takes counters from `tensorfold:generation/
  prompt_tokens_total`.
- Ledger integration test: two probe passes per backend produce non-zero
  minute/hour ledger deltas; exl3 keeps `cached_seen = false`.

### Excluded

- Capture-proxy usage rows (IR-154). UI changes (the lens already renders the
  ledger).

## Plan

1. Read the four existing `out.tokens` appliers as the pattern (vllm,
   llama.cpp, q27, ds4).
2. EXL3/TensorFold health + both TensorFold /metrics fallbacks emit tokens.
3. Tests alongside behavior; no schema change (contract already has tokens).

## Architecture impact

- **ADR required:** No — fills a field the existing contract defines.
- **Relevant ADRs:** None.

## Validation evidence

- Tests: `pnpm --filter @irori/agent test` — 196 passed (15 files); m7
  ledger suite 7 passed against disposable Postgres (54329).
- Build/typecheck: `pnpm -r build`, agent+server `tsc --noEmit` clean.
- Documentation check: no docs affected (no public behavior/config change).

## Review

- Correctness: token counters are the same raw values the rate windows
  consume; `hasCounters` gate mirrors the existing fallback condition so a
  live{}-only native build still reaches the /metrics token source.
- Security: none — read-only probe data already in the message schema.
- Compatibility: additive snapshot field; ledger already tolerates partial
  null triples.
- Residual risks: engines whose counters reset show a one-baseline re-seed
  (ledger is reset-safe). Live-hub confirmation happens on the next dev tag.
