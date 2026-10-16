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

- [ ] Research brief: bench protocols from sparkDash/sparkControl
      (`LlmProbe`, bench engines) — reuse request shapes, not code.
- [ ] Agent bench runners → run records → results API → UI.

## Architecture impact

- **ADR required:** No.
- **Relevant ADRs:** 0003 (runs via agent), 0006 (event stream).
- **Proposed ADR:** None.

## Validation evidence

- (pending)

## Review

- (pending)
