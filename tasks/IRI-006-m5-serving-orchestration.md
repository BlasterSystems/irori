# Task: IRI-006 — M5 Serving orchestration

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M5)

## Objective

Serving through the **setup wizard** and setup cards (SPEC §7): one
start/stop script pair on the head, validated per start, staged placement
transfers, and run logs pushed into telemetry. Homelab scale: 1–8 nodes,
most 1 head + 1 worker.

## Acceptance criteria

- [ ] Wizard: type (single / cluster ≤ 8 nodes) → model (NAS catalog search;
      chained HF download when the NAS lacks it) → per-node existence check →
      start/stop script paths with `test -x` validation on the head →
      placement plan → review → launch. One script pair orchestrates workers;
      ports/config live in the scripts.
- [ ] Script paths re-validated at **every start** (`test -x` via agent);
      a **stop script is required** — launch refused without one (fallback:
      recorded process group).
- [ ] Missing models transfer with **staged progress** (HF→NAS→head→workers),
      each stage showing %, rate, ETA, cancel; capacity math; busy-node
      warning; warnings never block.
- [ ] Setup cards: per-node state dots (healthy/starting/stopped/foreign),
      inline transfer progress, one-line engine log; detail drawer with
      streamed engine log, placement history, edit/duplicate/remove.
- [ ] Health: node LLM probe sees the engine on its script-defined port;
      startup timeout surfaces starting → healthy/failed. Optional env
      exports (MODEL_NAME/PORT/EXTRA_ARGS/MODEL_PATH) available to scripts.
- [ ] Detached drivers survive server restarts; logs stream into telemetry
      (ring + persisted run log).
- [ ] **M5 exit e2e:** serve GLM-5.3-flash cluster via the wizard — model
      staged NAS→head→worker, scripts validated, cluster started, logs
      visible in the UI.

## Scope

### Included

- `GET/POST /api/v1/setups`, `PATCH/DELETE /api/v1/setups/:id`,
  `POST /api/v1/setups/:id/start|stop`, `GET /api/v1/setups/:id/log` (SSE).

### Excluded

- Recipe folders / git-drift tracking (deferred, SPEC §14); generated serve
  commands (non-goal); inference gateway (deferred).

## Plan

- [ ] Research brief: cluster start/stop conventions observed on the existing
      setup (what start.sh does for workers, where ports live).
- [ ] Agent supervision primitives (spawn, pidfile, process-group stop, log
      ring) → setups API → wizard + cards UI.

## Architecture impact

- **ADR required:** No — serving model is specified in SPEC §7; if supervision
  semantics deviate from ADR-0003 assumptions, amend there.
- **Relevant ADRs:** 0003 (supervision via agent), 0004 (placement/modelctl),
  0006 (log streaming).
- **Proposed ADR:** None.

## Validation evidence

- (pending)

## Review

- (pending)
