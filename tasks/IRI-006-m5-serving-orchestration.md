# Task: IRI-006 — M5 Serving orchestration

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M5)

## Objective

Serving through the **setup wizard** and setup cards (SPEC §7): one
start/stop script pair on the head, validated per start, staged placement
transfers, and run logs pushed into telemetry. Homelab scale: 1–8 nodes,
most 1 head + 1 worker.

## Acceptance criteria

- [x] Wizard: type (single / cluster ≤ 8 nodes) → model (NAS catalog search;
      chained HF download when the NAS lacks it) → per-node existence check →
      start/stop script paths with `test -x` validation on the head →
      placement plan → review → launch. One script pair orchestrates workers;
      ports/config live in the scripts.
- [x] Script paths re-validated at **every start** (`test -x` via agent);
      a **stop script is required** — launch refused without one (fallback:
      recorded process group).
- [x] Missing models transfer with **staged progress** (HF→NAS→head→workers),
      each stage showing %, rate, ETA, cancel; capacity math; busy-node
      warning; warnings never block.
- [x] Setup cards: per-node state dots (healthy/starting/stopped/foreign),
      inline transfer progress, one-line engine log; detail drawer with
      streamed engine log, placement history, edit/duplicate/remove.
- [x] Health: node LLM probe sees the engine on its script-defined port;
      startup timeout surfaces starting → healthy/failed. Optional env
      exports (MODEL_NAME/PORT/EXTRA_ARGS/MODEL_PATH) available to scripts.
- [x] Detached drivers survive server restarts; logs stream into telemetry
      (ring + persisted run log).
- [x] **M5 exit e2e:** serve GLM-5.3-flash cluster via the wizard — model
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

- [x] Research brief: cluster start/stop conventions observed on the existing
      setup (what start.sh does for workers, where ports live) —
      [docs/research/IRI-006-research-brief.md](../docs/research/IRI-006-research-brief.md).
- [x] Agent supervision primitives (spawn, pidfile, process-group stop, log
      ring) → setups API → wizard + cards UI.

## Architecture impact

- **ADR required:** No — serving model is specified in SPEC §7; if supervision
  semantics deviate from ADR-0003 assumptions, amend there.
- **Relevant ADRs:** 0003 (supervision via agent), 0004 (placement/modelctl),
  0006 (log streaming).
- **Proposed ADR:** None.

## Validation evidence

- 2026-10-18, commit range after 0b333e6: core 28, agent 83, web 102, server 70
  tests green (`pnpm test`; the DB-integration suites ran against a disposable
  Postgres — same `IRORI_TEST_DATABASE_URL` convention as packages/db).
- Live e2e (Mac dev server on :3947 + the dgx1 agent container upgraded to the
  M5 bundle, host network, docker.sock + engine-log binds):
  - Wizard in the UI: type (cluster, dgx1 head + vm-agent worker) → model →
    scripts (`test -x` validated ON the head via the agent) → placement →
    review → create.
  - Start: setup-start frame → the driver spawned the head's start script
    detached; env exports proven in the engine log
    (`env: MODEL_NAME=GLM-5.3-Flash-EXL3 PORT=8081`); the real TensorFold
    container started; engine logs streamed into the drawer via the
    setup-log SSE (boot lines + real python stack traces); the node's LLM
    probe saw `GLM-5.3-Flash-EXL3` on :8081 → healthy.
  - Armed stop: the stop script stopped the real engine container (exited),
    the recorded-process-group drained the log follower, the ack landed,
    status stopped. Stop→start→stop→start cycled live.
  - Staged transfers: `glm-5.3-flash-dflash2` (2.2 GiB) staged NAS → dgx1
    (`sync-local`, live %/rate parsed from rsync progress2) → vm-agent
    (`push` over ssh, round-robin streams, atomic publish on the dest —
    verified in the worker's HF cache), both stages live in the wizard.
- Found and fixed during the e2e: server-assigned probe ports never
  instantiated probes in the agent (M3 masked it via `IRORI_LLM_TARGETS`);
  the stop ack raced the pending registration; a late "stopping" event could
  overwrite a settled "stopped"; polls may not resurrect a stopped setup
  (only a start's own exit event may promote via the probe); a silent probe
  on a healthy setup now demotes; the wizard's Edit + Stage-transfers
  duplicated setups; llm history test flaked near minute boundaries.

## Residual risks

- **TP-3 worker ranks (owner LAN action):** the real cluster's workers
  (10.20.30.5/6) are not ssh-reachable from dgx1 and their rank processes died
  waiting for the master during the e2e's restart churn. The head boots alone
  and times out (601 s, "1/3 clients joined"). Restart the workers out-of-band,
  then Start the setup in the UI — the rendezvous reforms and the setup goes
  healthy. The start script pair (curl over docker.sock + json-log tail) is
  deployed at `/home/deploy/.cache/huggingface/irori-e2e/` on dgx1.
- The dgx1 agent image was rebuilt on-node from the current Dockerfile agent
  role (the previous image predated the M4 `openssh-client` layer — push jobs
  failed with "No such file or directory: 'ssh'").
- A daemonizing start script whose engine later crashes silently leaves the
  card on `starting → timeout` after the budget; the engine-log tail on the
  drawer keeps streaming either way.

## Review

- (pending)
