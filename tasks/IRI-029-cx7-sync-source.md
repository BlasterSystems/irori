# Task: Placement pulls from the CX7 holder instead of the NAS

## Objective

When a node needs a model that the NAS store already holds but some other
node also holds locally (e.g. DGX-1 serving it), placement should offer the
node-to-node transfer over the CX7 fabric (push from the holder) instead of
the slower SMB sync from the NAS. NAS sync remains the fallback when no
online holder exists.

## Acceptance criteria

- [x] `planPlacement` returns `push` (viaNodeIds, online holders first) when an
  online local holder exists — even when the NAS also holds the model.
- [x] Falls back to `sync` (NAS) when the only holders are offline or none exist.
- [x] Placement route passes holder online flags into the planner.
- [x] Wizard staged transfers skip the NAS sync stage for NAS-mounting targets
  when an online holder exists (pass 2 pushes from it instead).
- [x] Model drawer shows the push source ("via <holder>") on push rows.
- [x] Core planner, server route, and staging tests updated.

## Scope

### Included

- `packages/core/src/catalog.ts` planner policy + `online` hint on `availableOn`.
- `apps/server/src/app.ts` placement route (holder online flags).
- `apps/server/src/setups-service.ts` staged-transfer pass 1 holder preference.
- `apps/web/src/components/ModelsView.vue` via-source hint on push rows.
- Tests + SPEC.md §6 wording + this task file.

### Excluded

- modelctl itself (push/sync-local mechanics unchanged, ADR-0004 untouched).
- NAS-first store policy for downloads (IRI-014) — the NAS stays the master copy.
- CX7 multi-link round-robin tuning (push `--host` shape unchanged).

## Plan

- [x] Inspect planner, route, modal, agent command builder, staging builder
- [x] Implement planner policy + route hints
- [x] Staged transfers holder preference
- [x] Modal via-source hint
- [x] Tests + docs
- [x] Validation

## Architecture impact

- **ADR required:** No — placement policy within the existing ADR-0004
  mechanisms (same `push`/`sync-local` job kinds, same agent surface, no new
  credentials, no data/deployment/integration change). Reversible one-branch
  policy decision in a pure function.
- **Relevant ADRs:** 0004 (modelctl as supply-chain engine)
- **Proposed ADR:** None

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — pass
- Tests: 699 passing — core 89 (3 new planner tests: CX7-first push, offline-holder sync fallback, online-first viaNodeIds ordering), web 237, proxy 22, db 4, agent 163, server 184 (new staging test: NAS-mounting target pushes from a reachable holder; store node keeps its own sync). Db-gated suites ran against a disposable Postgres container.
- Build: `pnpm build` green (all workspaces)
- Documentation check: `.agentic/bin/docs-check` — green
- Live smoke: throwaway stack (disposable PG, built server, two simulated agents hello + snapshot on /agent-ws): `GET /api/v1/placement` returned the NAS-mounting worker as `push` via the online holder id with correct bytes, the holder `present`; browser drawer showed "PUSH via smoke-dgx1d" with the Push button; offline nodes stayed advisory-unavailable.

## Review

- Correctness: verified end to end (planner unit tests, real-Postgres staging test, live route + hub smoke, browser drawer).
- Security: push surface unchanged (same modelctl push via agent token
  channel); no new credentials or hosts.
- Compatibility: `online` is an optional planner input; placement response
  schema unchanged (push rows already carried viaNodeIds).
- Residual risks: push runs on the source node (DGX-1) — transfers consume its
  CPU/IO while serving; accepted by the owner (CX7 speed wins). A spark node
  acting as the store is planned like any target (its NAS sync would be a
  local disk copy) — in this fleet the store node is the NAS (kind nas →
  present), and the wizard keeps the store node's own sync.
