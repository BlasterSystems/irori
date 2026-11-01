# Task: IRI-057 — orphan adoption states + Resume transfer

Jira **IR-133** (High). Spec home: `docs/research/IRI-049-transfer-remediation-research-brief.md`
(IRI-049/050 numbering collided with task files from other streams — this is
the IRI-049 work; the IRI-050 half is IR-134). Extends IR-104 (register-local +
orphan UI) and builds on IR-131 (transfer tracking + stop).

## Objective

A canceled/failed NAS→node `sync-local` leaves a partial `models--*` cache dir
that the agent reports as an orphan. The node page offered exactly one action,
**Register** — but `modelctl register-local` requires
`snapshots/<40-hex store commit>` and structurally refuses any interruption at
or before the snapshot rename, which is every mid-transfer stop. Live evidence:
canceled sync-local `51a3bf4c` (GLM-5.3-EXL3-2.75bpw-TensorFold, 9%, 28.9G) left
an orphan; register-local `d9a932b8` failed with `has no snapshot for store
commit '2d747d0e…'`. The designed recovery — re-running `sync-local` (cheap:
deterministic staging dir + `rsync --partial` resume) — had no UI affordance.

## Acceptance criteria

- [x] A canceled mid-transfer sync surfaces as a resumable orphan with a
      Resume CTA (not Register).
- [x] Resume dispatches `sync-local` for that node + cache user; on success
      the entry registers and the orphan row disappears (completed blobs are
      not re-copied — modelctl's staging determinism).
- [x] An adoptable orphan still shows Register (zero-transfer path preserved).
- [x] Reports from pre-classification agents (orphans as plain strings, no
      states) still render — Register-only fallback.

## Scope

### Included

- `packages/core/src/inventory.ts`: additive optional `orphanStates`
  (`{repo, state: adoptable|resumable|unknown}`) on `InventoryLocalCache`,
  defaulted `[]` so pre-change agents and cached rows keep parsing. `orphans`
  unchanged.
- `apps/agent/src/inventory.ts`: classify each unregistered `models--*` dir
  from the on-disk layout (no NAS round-trip) — `snapshots/<40-hex>/` dir →
  adoptable; only `.modelctl-staging/<40-hex>-*` → resumable; else unknown.
- `apps/agent/src/modelctl.ts`: `sync-local` now honors an explicit
  `params.user` with the same per-user runuser rule as `register-local`
  (the Resume dispatch targets the cache owner the listing came from, which
  may differ from the node's configured cache user). No `user` → IR-101
  behavior (node cache user) unchanged.
- `apps/web/src/inventory.ts`: `orphanRowsFor` (join states, default unknown),
  `orphanHint`, `resumeRequestFor`/`resumeCopy`.
- `apps/web/src/components/NodeDetail.vue`: per-state CTA (resumable → Resume
  transfer, adoptable/unknown → Register), per-row resumable hint.

### Excluded

- Server changes — the dispatch path and `INVENTORY_MUTATING_KINDS` cached-report
  drop already exist.
- modelctl SIGTERM journaling (brief G4) — deferred, upstream pinned dep.
- Relay busy state / 409 surfacing (IR-134).

## Plan

1. Core schema (additive, defaulted).
2. Agent classifier + per-user sync-local argv.
3. Web shaping helpers + NodeDetail per-state CTA.
4. Tests: agent orphan classification (adoptable/resumable/unknown + empty),
   agent sync-local per-user argv, web orphanRowsFor/resume shaping.

## Architecture impact

- **ADR required:** No — the Resume path reuses the existing `sync-local` job
  (ADR-0011 runuser shape); Register stays the only adoption path (ADR-0012,
  fail-closed). No new job kind, no new boundary.
- **Relevant ADRs:** ADR-0011, ADR-0012, ADR-0013.

## Validation evidence

- Tests: 850 workspace green — agent 197 (3 assertions for the three
  classification states + per-user sync-local argv), web 295 (orphanRowsFor
  join/unknown-fallback/hint, resumeRequestFor/resumeCopy), server 228, core
  100.
- Build/typecheck/validate/docs-check: see PR.
- Live: cancel a sync-local mid-transfer on a DEV node → Refresh → the orphan
  row must show Resume transfer (not Register); completing it registers the
  entry with no re-copy. Rides the next dev tag + agent update.

## Review

- Correctness: classification is purely structural, matching modelctl's own
  register preconditions — adoptable is exactly "snapshot farm exists", so the
  Register CTA is never offered where it structurally cannot succeed, and
  Resume never offered where a snapshot farm (and thus possible adoption) is
  present. Unknown preserves the old behavior.
- Compatibility: additive defaulted schema field; pre-0.23 agent reports and
  old cached `node_inventory` rows parse unchanged → all-unknown → Register
  only. `sync-local` without `user` is byte-identical to before.
- Security: no new surface — Resume dispatches the already-permitted
  `sync-local` job kind; runuser wrap reuses the ADR-0011 shape.
- Residual risks: the adoptable heuristic is structural only (a snapshot farm
  from a failed earlier publish is conceivable) — register-local stays
  fail-closed, worst case a failed job with modelctl's mismatch text. A stale
  cached report can show Resume for something already registered — sync-local
  into the completed state re-registers idempotently.
