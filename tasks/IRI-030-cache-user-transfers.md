# Task: Per-node cache user for model transfers

## Objective

Model transfers (sync-local, push) currently run as the agent user (root), so
models land in `/root/.cache/huggingface/hub` and the owner cannot find them in
their own HF cache (IR-101 report: two 163.6 GiB syncs on DGX-1/DGX-2
published to root's cache). Add an optional per-node **cache user**: the agent
runs sync-local and the push source side via `runuser` as that user (IRI-028
delete-local pattern); push destinations are addressed as `user@host` composed
from the destination node's setting by the server and the web drawer. Unset
(or equal to the agent user) keeps today's behavior.

## Acceptance criteria

- [ ] `nodes.cache_user` column (validated username) with migration; create,
  patch, and NodeInfo expose it.
- [ ] Hub config-update carries `cacheUser`; agent applies it to modelctl runs.
- [ ] sync-local with a cache user runs via `runuser` with the user's modelctl
  binary and scrubbed env; a missing user modelctl fails the job with an
  actionable error; unset/agent-user behaves as today.
- [ ] push: source side as the node's cache user; destination hosts composed as
  `user@host` by setups staging and the web drawer; unknown hosts pass through.
- [ ] Node form gains the cache user field (validated).
- [ ] Tests: db store, core schemas, agent buildCommand, setups composition.
- [ ] SPEC + ADR document the decision and the ssh/modelctl prerequisites.

## Scope

### Included

- packages/db: schema + migration + store.
- packages/core: node schemas, config-update message, placement row.
- apps/agent: transport field, ctx, buildCommand wrapping for sync-local + push.
- apps/server: hub config-update, node create/patch, placement route, setups
  push host composition.
- apps/web: node form field, drawer push host composition.
- docs: ADR + SPEC.

### Excluded

- Installing modelctl for the cache user (owner ops; documented prerequisite).
- User-level ssh key setup between nodes (owner ops; documented prerequisite).
- delete-local (already per-user via IRI-028), download-queue (NAS-side).

## Plan

- [x] Diagnose the report (job logs: both syncs published to /root/.cache)
- [x] Implement DB + core + agent + server + web
- [x] Tests + docs
- [x] Validation + live smoke (real sync-local as the cache user)

## Architecture impact

- **ADR required:** Yes — changes where the supply chain writes model data
  (integration boundary + security surface: the agent now spawns processes as
  another user). ADR-0010.
- **Relevant ADRs:** 0004 (modelctl as supply-chain engine), 0003 (agent trust
  boundary), IRI-028 per-user cache inventory.
- **Proposed ADR:** 0010 cache-user transfers.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — pass
- Tests: 711 passing — core 93 (new node.test.ts: cacheUser schema + config-update wire), web 238 (node-form + fixture updates), proxy 22, db 5 (create/patch persistence), agent 167 (sync-local/push runuser wrapping, self-user shortcut, missing-modelctl failure), server 186 (hub config-update carries cacheUser, setups user@host composition, llm config expectations)
- Build: `pnpm build` green (all workspaces)
- Documentation check: `.agentic/bin/docs-check` — pass (ADR-0011, SPEC §6, API.md node payloads)
- Live smoke (throwaway PG + built server + simulated agent): migration applies; POST with `cacheUser` echoes it; PATCH updates and `null` clears; invalid usernames (`-root`, `a b`, `x;rm`) → 400; `GET /api/v1/placement` rows carry the destination's `cacheUser`; the agent `config-update` carries `cacheUser` alongside `nasRoot`. The runuser execution path is Linux-only and covered by argv unit tests; fleet-level proof needs the owner's agent update + user modelctl installs (see residual risks).

## Review

- Correctness: verified end to end (unit argv tests, hub config-update test, staging composition test, db persistence test, live API/wire smoke).
- Security: cacheUser validated (^[A-Za-z_][A-Za-z0-9_-]{0,31}$) and interpolated only into a runuser argv (no shell); the hub sends the user name, never paths; binaries resolve agent-side from /etc/passwd; a missing user modelctl fails the job instead of falling back to root's cache.
- Compatibility: additive nullable column + optional schema fields; unset behavior identical to today; placement response schema extended with a defaulted field.
- Residual risks: push end to end requires user-level ssh keys between sparks and a modelctl install for the cache user on each destination (owner ops, documented in SPEC/ADR-0011); failures surface as actionable job errors. The fleet agents are still 0.3.0 — the new behavior activates after the owner updates them (restarts stop running setups; DGX-1 serves TP-3).
