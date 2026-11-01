# Task: IRI-056 — placement presence reconciles with live node inventory

Jira **IR-140** (Bug, filed under IR-135). Placement/presence is IRI-028/M4
territory. Independent of IR-133/IR-134.

## Objective

Edit-setup Placement showed DGX-2/DGX-3 as `push` (163–175 GiB) for models
that `modelctl list --local` and the node pages' Local cache sections already
list as resident. Presence for placement/start was the `node_models` table,
written ONLY when a transfer job settles with a non-empty `params.name`. A
model that reached a node outside a successful hub job (registered locally,
transferred before the table existed, manual modelctl use, pruned job rows)
never became present — so `planPlacement` demanded redundant 175 GB pushes and
setup start refused with `not staged on …` for a resident model.

## Acceptance criteria

- [x] After a node inventory refresh, placement reports present (not push) for
      every model listed in that node's local caches.
- [x] Setup start no longer blocks with `not staged` when the head inventory
      lists the model (it reads the reconciled `presentNodesFor`).
- [x] Nodes without the model still show push with correct bytes; the Qwen
      control case (inventory already agreed with placement) is unchanged.
- [x] Unit tests: reconcile upserts from a report; no prune on a partial
      report; `presentNodesFor` union.
- [x] No schema change (node_models + node_inventory already exist).

## Scope

### Included

- `apps/server/src/jobs-service.ts`:
  - `reconcilePresenceFromInventory(db, nodeId, report)` — on a succeeded
    `models-inventory` settle, upsert `node_models` for every model in
    `report.local[].models`. Prune stale rows ONLY when the report is known
    complete (≥1 cache read AND every cache read succeeded); a failed cache
    read reports empty models and must not delete true presence.
  - Wire it into the `models-inventory` settle branch (was: only
    auto-provision ran).
  - `presentNodesFor` unions the cached `node_inventory` report as a defense
    (node_models stays authoritative); a cached row is deleted on any
    model-mutating settle, so the union never resurrects a deleted model.

### Excluded

- Agent `reportStatus` self-verification, recipe contract docs, node-role
  display in the same modal (IR-135/S2).

## Plan

1. Reconcile helper + settle wiring; prune gated on a complete report.
2. `presentNodesFor` union of the cached inventory (defensive read path B).
3. Tests in `job-events.test.ts`: complete-report upsert+prune, partial-report
   no-prune, all-empty complete prune, cached-only union + settle invalidation.

## Architecture impact

- **ADR required:** No — feeds an existing table from an existing report;
  no schema/contract change.
- **Relevant ADRs:** ADR-0004 (modelctl owns the store; the inventory is a
  read-only projection), IRI-028 (per-node inventory cache).

## Validation evidence

- Tests: server 228 green (2 new: reconcile upsert/prune-on-complete/
  no-prune-on-partial, and the presentNodesFor cached-union + settle
  invalidation); full workspace suite green.
- Build/typecheck/validate/docs-check: see PR.
- Live: after the next dev tag + an inventory refresh on DGX-2/DGX-3, the
  Placement step reports present for the resident GLM models (control Qwen
  model unchanged).

## Review

- Correctness: upsert is idempotent (onConflictDoNothing); the prune deletes
  only rows whose model is absent from a KNOWN-COMPLETE listing; a report
  with zero caches (`local: []`) is treated as incomplete (no prune) so a
  pre-0.23 agent that reports nothing cannot wipe presence.
- Security: none new — reads the agent's already-persisted report.
- Compatibility: no API/schema change; older agents that report a partial
  local list simply never trigger a prune (presence is a superset, never a
  regression).
- Residual risks: a model removed from a node by a path that deletes no
  `node_models` row and does not mutate the inventory stays falsely present
  until the next COMPLETE inventory report prunes it — the same inventory
  refresh closes the loop.
