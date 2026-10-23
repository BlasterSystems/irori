# IRI-018 research brief — delete from NAS on the models list

- **Date:** 2026-10-22
- **Ticket:** IRI-018
- **Goal:** The owner asked to "allow delete from NAS on the models list".
  Establish what already exists end-to-end, what the actual gap is, and the
  smallest complete change.

## 1. NAS delete already exists across every layer

The full dry-run/armed two-step shipped with M4 (IRI-005). Evidence:

- **Agent job kinds** (`apps/agent/src/modelctl.ts:161-170`):
  `nas-delete` → `modelctl delete NAME --root …` (dry-run default) and
  `nas-delete-apply` → `delete NAME --apply --yes --root …`; pinned by
  `apps/agent/test/m4.test.ts:67-70`. The destructive-kinds convention is the
  module docstring: "Destructive kinds are separate dry-run / armed jobs; the
  armed variant passes --apply --yes explicitly" (`modelctl.ts:13-14`).
- **Core allowlist** (`packages/core/src/jobs.ts:14-15`) and **server allowlist**
  (`apps/server/src/jobs-service.ts:65-67`) both include both kinds; on a
  terminal `nas-delete-apply` the hub removes the (node, model) row from
  `node_models` (`jobs-service.ts:268-270`).
- **Web actions**: `JOB_VERBS` labels "Delete from NAS (dry run)" (non-
  destructive) and "Delete from NAS (APPLY)" (destructive)
  (`apps/web/src/models.ts:216-218`); the model detail drawer renders a
  "Delete (dry run)" button on the NAS placement row
  (`apps/web/src/components/ModelsView.vue:554-560`), with the footnote
  "destructive deletes are armed via a second apply job" (`:571-572`).

## 2. modelctl `delete` semantics (what the arm actually does)

- CLI (`modelctl/src/modelctl/cli.py:631-662`): `delete NAME` is **dry-run by
  default**; `--apply` performs it; `--yes` "skip[s] the typed confirmation
  (required when stdin is not interactive)"; `--json` emits JSON. Handler:
  dry-run plan → confirm → apply (`cli.py:1389-1396`).
- Semantics (`modelctl/src/modelctl/operations.py:600-703`): dry-run classifies
  everything that *would* be removed without touching the store. With `--apply`:
  the active reference is removed **first** (inverse of update's active-last),
  the catalog is refreshed under the lock, then model staging is cleaned
  (`cleanup_staging --apply`), then the model's now-unreferenced objects are
  re-checked (status must still be `unreferenced`) and `rmtree`d. A delete
  journal `state/NAME.delete.json` is retained as evidence; a mid-way failure
  leaves the store consistent and recoverable via the existing audit/gc
  commands.
- Serialization: jobs are one-active-per-node, so a delete can never run
  concurrently with a download batch on the store node.

## 3. The actual gap: discoverability and flow placement

The store-models list rows (`ModelsView.vue:465-469`, `v-for` over
`modelsPage.models`, row click → `openModel`) expose **no** delete entry
point. Today a delete requires: open the model drawer → find the NAS row in
the placement table → "Delete (dry run)" → then locate the armed apply in the
collapsed "Store maintenance…" verb list (`ModelsView.vue:570-578`,
`models.ts:216-218`). Nothing on the models list itself says delete is
possible — matching the owner's request.

## 4. Options

| Option | Change | Tradeoff |
|---|---|---|
| **A. Row-level two-step delete flow (recommended)** | "Delete from NAS…" button on store-model rows (and keep the drawer button); clicking runs `nas-delete` on the store node (NAS-preferred, the node with `kind: "nas"`) via the existing job modal, shows the plan output, and offers an explicit "Arm delete" that fires `nas-delete-apply` for the same name | Reuses all existing kinds/allowlists; zero agent/server/DB change; the two-step arm stays explicit |
| B. Drawer-only fix | Put the armed apply next to the dry-run button in the NAS placement row | Smallest diff, but still invisible from the list |
| C. Status quo | None | Doesn't address the request |

Design notes for A:

- Arm only after a **successful dry-run of the same (node, name)**; disable the
  arm until the plan output is visible (matches the armed-jobs convention).
- Advisory warning when a serving setup references the model name
  (`setups.model`, `packages/core/src/setups.ts:46-47`): deletion removes the
  reference and objects; a running engine keeps its open file handles until
  restart, then fails to start. Per SPEC style, warnings never block — no hard
  guard exists in modelctl (`delete_model` checks nothing about consumers).
- After the arm settles, trigger a catalog/placement refresh (the batch path
  sends `catalog-request` after terminal batches,
  `download-queue-service.ts:202-204,234-235`; verify the single-job path
  refreshes the store catalog too — jobs-service reconciles `node_models` but
  store-catalog refresh on `nas-delete-apply` needs confirming during
  implementation).
- Optional: pass `--json` on both delete jobs (`cli.py:661`) for a structured
  plan (`removed_staging`, `retained_staging`, `removed_objects`,
  `retained_objects`) instead of human text; current argv omit it
  (`modelctl.ts:164,169`).

## Summary of Findings

Delete-from-NAS is fully built (agent kinds, core/server allowlists, hub
`node_models` reconcile, drawer dry-run + armed apply). The gap is purely UX:
no entry point on the models list, and the armed step is hidden in a collapsed
menu. Decision: option A — a row-level "Delete from NAS…" flow on the models
list that runs the existing dry-run, shows the plan in the job modal, then
arms `nas-delete-apply` explicitly. No agent, server, schema, or modelctl
change is required; optionally add `--json` to the two delete jobs for a
structured plan, and verify catalog refresh after the arm.

Open items: exact current arm-flow wiring (`HYGIENE_VERBS`/`perModel`
handling in `ModelsView.vue`) to be read during implementation; catalog-refresh
behavior after a single-node apply job.

## Correction 2026-10-22 (implementation)

- §1 overstated the armed apply's UI coverage: `JOB_VERBS` (models.ts) is an
  exported-but-unrendered list — `nas-delete-apply` had **no** UI path
  anywhere. The implemented flow adds it (arm inline in the job drawer, gated
  on the same drawer job being a succeeded `nas-delete` with a name param).
- Open item 2 resolved: `nas-delete-apply` is in `CATALOG_MUTATING_KINDS`
  (`apps/server/src/jobs-service.ts:63-72`), so the hub already sends
  `catalog-request` when the arm succeeds — no server change needed; the web
  refetches the models list on terminal delete jobs (plus one delayed
  refetch to cover the catalog round-trip).
