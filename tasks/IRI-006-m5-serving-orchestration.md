# Task: IRI-006 — M5 Serving orchestration

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M5)

## Objective

Cluster serving from user-owned recipes and scripts: register/probe, start/
stop/status/logs via the agent, placement-aware starts, and run logs pushed
into telemetry.

## Acceptance criteria

- [ ] Recipe register by (node, path); probe: entry variants, `PORT`, `MODEL`,
      dispatch verbs (`start|stop|status|logs`), containers, `.env` **presence
      only** — values never leave the node; Irori never edits recipes.
- [ ] Script-class runs: library scripts (env contract `MODEL_NAME`, `PORT`,
      `EXTRA_ARGS`) and run-by-path with stable derived ids.
- [ ] Start/stop/status/logs execute via the agent; detached drivers survive
      server restarts; run logs stream into telemetry (ring + persisted).
- [ ] Start prechecks: MODEL placement (absent ⇒ 409 + remediations + force;
      unknown ⇒ warning), capacity math, transfer-contention warning.
- [ ] Multi-node recipe guard: `NNODES`/`WORKER_IP` vs configured cluster
      worker (exact-delta refusal dialog).
- [ ] **M5 exit e2e:** serve GLM-5.3-flash cluster — recipe on head, model
      synced NAS→head, pushed head→worker, cluster started, logs visible.

## Scope

### Included

- `GET/POST /api/v1/recipes`, `POST /api/v1/runs/:id/start|stop`,
  `GET /api/v1/runs/:id/log` (SSE).

### Excluded

- Generated serve commands (non-goal); gateway (deferred).

## Plan

- [ ] Research brief: recipe dispatch conventions observed on the existing
      cluster (start.sh verbs, .env keys).
- [ ] Agent supervision primitives (spawn, pidfile, process-group stop, log
      rotation) → runs API → UI table + console tail.

## Architecture impact

- **ADR required:** No — serving model is specified in SPEC §7; if supervision
  semantics deviate from ADR-0003 assumptions, amend there.
- **Relevant ADRs:** 0003, 0004 (placement), 0006 (log streaming).
- **Proposed ADR:** None.

## Validation evidence

- (pending)

## Review

- (pending)
