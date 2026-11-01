# Task: IRI-058 — relay busy state on Push/Register/Refresh

Jira **IR-134** (Medium; parent IR-135). Spec home:
`docs/research/IRI-049-transfer-remediation-research-brief.md` (the IRI-050
half; IRI-049/050 numbering collided with task files from other streams — the
IRI-049 half shipped as IRI-057/IR-133). Extends IR-121 (push drawer); respects
ADR-0014's one-active-slot constraint rather than bypassing it.

## Objective

Model push dispatches to the relay node (`viaNodeIds[0]`);
`POST /api/v1/nodes/:id/jobs` 409s with `node already has an active job (...)`
whenever the relay has ANY queued/running job. The only surface was an inline
banner inside the already-open drawer, and the Push button's visibility checked
only destination online — never relay busy. The owner read the 409 as "push not
working" (2026-10-30 08:44:03: DGX-1's slot held by sync-local `4fcf1f15`).

## Acceptance criteria

- [x] With a queued/running job on the relay, the Push row shows the busy
      state naming the blocking job (disabled button `Busy`, row line
      `DGX-1 busy — sync-local GLM-5.3-Flash-EXL3-4bpw-TensorFold, 31%`).
- [x] A stale click still 409s; the drawer banner names kind + model of the
      blocking job (server message widened from id-only).
- [x] NodeDetail Register (and the new Resume transfer) and inventory
      Read/Refresh show the same busy treatment.

## Scope

### Included

- `apps/server/src/jobs-service.ts`: the busy fast-path 409 now names the
  blocker — `node already has an active job: <kind> <name>` (falls back to
  `kind (id)` for nameless jobs). The race-path unique-violation message
  stays generic (no row to read).
- `apps/web/src/jobs.ts`: `activeJobFor` / `activeJobsByNode` /
  `blockingJobLabel` — pure helpers over the live jobs map (seeded from
  `GET /api/v1/jobs`, kept current by SSE `job`/`job-progress`).
- `apps/web/src/components/ModelsView.vue` placement drawer: `dispatchBlocker`
  = the active job on the DISPATCHING node (push → relay `viaNodeIds[0]`,
  sync/delete → the node itself). Busy renders the row hint +
  disabled `Busy` button with the full blocker label in the title.
- `apps/web/src/components/NodeDetail.vue`: `nodeBusyJob`/`nodeBusyLabel`
  disable + title the three inventory Read/Refresh buttons and Register /
  Resume transfer on the orphan rows.

### Excluded

- Bypassing the one-active slot for pushes (rejected in the brief: relay
  resource contention).
- Reactive busy-retry of user-initiated pushes (rejected: delayed surprise
  dispatch; ADR-0014 retry is for the remediation path only).
- Local model-row Delete buttons (not in the ticket; already guarded by
  `opBusy` while the page's own dispatch is in flight).

## Plan

1. Server: widen the 409 message (kind + params.name).
2. Web: pure busy-state helpers over `live.jobs`.
3. ModelsView drawer + NodeDetail buttons render the blocker.
4. Tests: db-gated named-blocker test; pure helper unit tests.
5. Browser verification with the fixture router (busy + idle states).

## Architecture impact

- **ADR required:** No — the constraint (one active job per node, ADR-0014)
  is unchanged; only its visibility.
- **Relevant ADRs:** ADR-0014; IRI-051 precedent (syncing chip from live
  jobs).

## Validation evidence

- Tests: full workspace green — server 229 (named-blocker test: blocker
  kind+name in the message, kind+id fallback for nameless jobs); web 298
  (activeJobFor/activeJobsByNode/blockingJobLabel cases); agent 197, core
  100, proxy 24, db 5.
- Browser (fixture hub, vite dist + init-script fetch router, seeded
  `live.jobs` via `GET /api/v1/jobs`):
  - Placement drawer with DGX-1 holding `sync-local … 31%`: DGX-2 push row →
    `Busy` disabled, row names `DGX-1 busy — sync-local
    Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold, 31%`; DGX-3 (idle relay
    DGX-2) keeps enabled `Push`; idle → all buttons enabled.
  - Node page: Refresh/Register/Resume all disabled with the blocker title;
    idle → enabled. Screenshot captured.
- SPEC.md placement contract updated.

## Review

- Correctness: the blocker is the DISPATCHING node's active job — matching
  the server's `jobs.create` busy check exactly (relay for push, node for
  sync/delete-local/nas-delete-apply).
- Compatibility: the 409 message is display-only (no client parses it); the
  race-path message is unchanged.
- Residual risks: the seed covers the last 20 jobs — a node whose active job
  predates the seed shows enabled until the SSE frame arrives (the stale
  click still gets the self-explanatory 409). Multi-stream transfers report
  parsed progress only on single-stream jobs, so the percent suffix may be
  absent — label degrades to `kind name`.
