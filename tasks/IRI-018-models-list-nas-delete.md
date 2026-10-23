# Task: Delete from NAS on the models list

## Objective

Surface the existing NAS delete (dry-run → armed apply) as an entry point on
the store-models list. All plumbing exists end-to-end (agent kinds
`nas-delete`/`nas-delete-apply`, core/server allowlists, hub `node_models`
reconcile, drawer dry-run button) — see
`docs/research/IRI-018-research-brief.md`. The gap is discoverability: the
models list has no delete affordance and the armed apply hides in a collapsed
maintenance menu.

## Acceptance criteria

- [x] Store-model rows on the models list offer a "Delete from NAS…" action.
- [x] The flow runs `nas-delete` on the store node (the `kind: "nas"` node)
      through the existing job modal and streams the plan output.
- [x] The armed `nas-delete-apply` fires only from an explicit arm step, and
      only after a successful dry-run of the same (node, name) — the arm row
      renders from the drawer's own succeeded `nas-delete` job
      (`armableNasDelete`), so the target is the dry-run's own node + name.
- [x] Advisory warning when a serving setup references the model name
      (fetched non-blocking via `fetchSetups` + `setupServingModel`);
      warnings never block (SPEC style).
- [x] Catalog/placement refresh after the arm settles — already server-side:
      `nas-delete-apply` is in `CATALOG_MUTATING_KINDS`; the web refetches
      the models list on terminal delete jobs (+ one delayed refetch).
- [x] Tests cover the new flow gating (`apps/web/test/nas-delete.test.ts`);
      suites + typecheck green.

## Scope

### Included

- `apps/web` ModelsView/models-list UI only (reusing existing job kinds and
  the job modal), plus the catalog-refresh verification.

### Excluded

- No agent, server, DB, or modelctl changes.
- Optional (implementer's call, brief §4): add `--json` to the two delete job
  argvs (`apps/agent/src/modelctl.ts:164,169`) for a structured plan.

## Plan

- [x] Research: `docs/research/IRI-018-research-brief.md` (decision-complete)
- [x] Read the current drawer flow — found `JOB_VERBS` unrendered (the armed
      apply had no UI path at all; brief has a dated correction)
- [x] Row-level delete entry point + dry-run → review → arm modal flow
- [x] Setup-reference advisory warning
- [x] Catalog refresh after arm settles (server-side already; web refetch)
- [x] Tests + validation

## Architecture impact

- **ADR required:** No — pure UI surface over existing destructive-job
  convention (two-step dry-run/arm, `apps/agent/src/modelctl.ts:13-14`).
- **Relevant ADRs:** ADR-0004 (modelctl store engine), ADR-0005 (web UI
  system), ADR-0009 (store lifecycle).
- **Proposed ADR:** None.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` → exit 0.
- Tests: `pnpm --filter @irori/web test` green including the new
  `test/nas-delete.test.ts` (arm gating + advisory matcher) and the
  IRI-017 helper tests; full `pnpm -r test` green (server 164/164 against a
  disposable Postgres); `pnpm --filter @irori/web typecheck` exit 0.
- Build: `pnpm -r build` exit 0.
- Documentation check: `.agentic/bin/docs-check` → exit 0.
- Browser verification (built bundle at #/models, fetch stubs for
  nodes/models/setups/jobs): the row button renders exactly once per model;
  clicking runs the dry-run and opens the job drawer; the serving-setup
  banner shows "Setup \"flint-serve\" serves this model — deleting breaks its
  next start (advisory, never blocks)"; the "Arm delete (APPLY)"
  `btn--danger` row appears only on a succeeded dry-run and clicking it
  dispatches `nas-delete-apply` for the same node + name.

## Review

- Correctness: the arm is keyed to the drawer's own succeeded `nas-delete`
  job (`armableNasDelete`) — node and name are the dry-run's own by
  construction, so no cross-model arming is possible; the apply job is
  serialized by one-active-per-node.
- Security: no new command surface (existing allowlisted kinds and params);
  the arm is an explicit second click after visible plan output.
- Compatibility: web-only change; the drawer's old dry-run button and the
  "Store maintenance…" verbs are untouched.
- Residual risks: deleting a model that a running setup serves breaks that
  setup's next start (advisory-warned, not blocked); `JOB_VERBS` in
  `models.ts` remains an exported-but-unrendered list (pre-existing dead
  export, left as-is — the live flow does not use it).
