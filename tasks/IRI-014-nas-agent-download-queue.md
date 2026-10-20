# Task: IRI-014 — NAS-agent downloads + persistent download queue

Jira: [IR-63](https://blastersystems.atlassian.net/browse/IR-63) (IR Sprint 1; epic IR-24 M4 Model supply chain)

## Objective

"Download from HF…" on /models runs modelctl on the NAS agent (NAS-preferred
model-ops selection, mirroring the setups-service precedent), and adding a download
always forms a durable server-side queue: entries dispatch as a single `download-queue`
batch on the store node when it is idle — no immediate one-off starts, no 409 dead-ends
for downloads.

## Acceptance criteria

- [x] Download target selection prefers `kind === "nas" && nasRoot !== null && enabled
      && online`, falling back to other online `nasRoot` nodes only when no NAS-kind
      node is online (same preference order as `setups-service.ts:656-659`).
- [x] Adding a download while the store node has an active job enqueues it in a
      DB-backed pending queue instead of failing with 409; non-download job kinds keep
      the current one-active-per-node behavior.
- [x] The queue dispatches all pending entries as one `download-queue` batch when the
      store node is idle; after a terminal batch status the next pending entries
      dispatch; a server restart reconciles pending state (dispatch on boot if idle).
- [x] Failed batch entries are reconciled against the store catalog (source of truth)
      and marked failed; per-entry retry/remove is available.
- [x] Models page shows the pending download queue with per-entry remove; the job
      drawer still streams the running batch.
- [x] Tests: queue service (enqueue, dispatch-when-idle, restart reconcile, failure
      reconciliation) and node-selection preference; existing suites stay green.

## Scope

### Included

- Server: pending download queue table/migration + queue service, jobs-service
  dispatch hook on idle store node, boot reconcile.
- Web: Models page node-selection preference, pending-queue panel, submit flow feeds
  the queue.

### Excluded

- modelctl changes (its queue is invocation-scoped YAML by design — see brief §3).
- sync-local/push placement and delete flows (unchanged).

## Plan

- [x] Research brief: [docs/research/IRI-014-research-brief.md](../docs/research/IRI-014-research-brief.md)
      (download placement, queue semantics, options A–D).
- [x] Verify NAS agent prerequisites live: modelctl presence + store access verified via a
      live `doctor` job on the NAS node (doctor ran against `/mnt/llms`); HF egress is
      exercised by the first real download's preflight (not triggered in this task).
- [x] Server: pending download queue (table + service + dispatch/reconcile).
- [x] Web: NAS-preferred node selection + pending-queue UX.
- [x] Add or update tests.
- [x] Update documentation (models page behavior; ADR-0004 unchanged).
- [x] Run validation: `.agentic/bin/validate`, `.agentic/bin/docs-check`.

## Architecture impact

- **ADR required:** No — implements ADR-0004 (modelctl stays the engine; store still
  mutated only via modelctl) within the ADR-0003 job model; the queue is server-side
  Irori state.
- **Relevant ADRs:** 0003, 0004.
- **Proposed ADR:** None.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` exit 0 ("Configuration validation
  passed"). `.agentic/bin/docs-check` exit 0 (heuristic WARNING about config docs
  concerns the pre-existing uncommitted tree, not this task).
- Tests: `pnpm -r test` all green — core 60 (incl. new `downloads.test.ts` policy
  tests), db 4, proxy 8, web 183 (incl. new ModelsView chrome pins), server 129 (incl.
  new `download-queue.test.ts`: 9 db-gated cases — dispatch/NAS preference, queue-while
  -busy, offline pending → drain, failed-batch reconcile from modelctl terminal lines,
  cancel, retry, remove, recover), agent 132.
- Build: `pnpm build` exit 0 (core/db/proxy tsc, web vue-tsc + vite, agent esbuild,
  server tsc).
- Live smoke (local full stack): built server on disposable Postgres — POST
  `/api/v1/downloads` 202 with derived store name; invalid payload 400; pending rows
  with no online store node; DELETE 204/404; queue list. Browser (built bundle):
  Models page renders the queue panel; modal adds an entry (row appears with name ·
  source); Remove deletes the row; "Download from HF…" is enabled without an online
  store node and the modal explains adds queue until one is online (gating fixed after
  the smoke caught the old disabled state). Smoke surfaced + fixed: the disabled
  download button and an inert `<template>` wrapper that blanked the modal form.
- Live NAS check: `doctor` job on the NAS node via the running hub — modelctl executed
  on the NAS agent against `/mnt/llms` (structured store diagnostics). Exit 1 from
  pre-existing `missing_journal` findings on two `tiny-random-*` test models — store
  hygiene, not a placement blocker (repair flow exists).

## Review

- Correctness: queue semantics covered by db-gated integration tests; reconcile relies
  on modelctl exiting non-zero when ANY entry failed (succeeded ⇒ all published) plus
  terminal `[i/n] complete|failed` labels (printed last, ring-safe).
- Security: no agent changes — job kinds, argv building and the privileged surface are
  untouched; new endpoints accept no secrets and validate via core schemas; YAML is
  still built by the agent's escaped `buildQueueYaml`.
- Compatibility: setup transfer chains keep working (reconcile ignores
  `download-queue` jobs with no queue rows); setups-service now shares
  `pickStoreNode` with identical NAS-first semantics.
- Residual risks: (1) HF egress from the NAS is proven only at the first real
  download's preflight; (2) reconcile depends on modelctl's terminal label format
  (version-pinned; a drift mislabels failed rows, retry is idempotent via reuse of
  published objects); (3) terminal queue rows accumulate without pruning (list caps at
  50 — retention hook can be added later); (4) a deploy (dev tag) is needed for the
  fleet to run this; live e2e of an actual download deliberately deferred to
  post-deploy (no real store writes from the task); (5) consecutive adds form separate
  batches — no mid-batch coalescing (documented in ADR-0009).
