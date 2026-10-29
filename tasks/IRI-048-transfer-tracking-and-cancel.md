# IRI-048 — Transfer tracking + stop: recoverable progress and cancel for sync-local and push

**Jira: [IR-131](https://blastersystems.atlassian.net/browse/IR-131)** (Task, IR Sprint 2 / sprint 990, assignee Bruno).

## Goal

Owner asks from 2026-10-29 (with a Models-view screenshot of the placement modal + a `sync-local` job sheet):

1. **A transfer that outlives its modal is unmanageable.** In ModelsView, closing the job sheet (`closeJob()`) nulls the only handle — no op-bar, no list, nothing. The Overview Telemetry feed streams the same lines read-only. After a close or any navigation, the operator cannot see, revisit, or stop a running `sync-local` (NAS → node) or `push` (node → node). Cancel exists in the API; the UI just loses reach.
2. **Progress is raw rsync text, not state.** `parseTransferProgress` (`packages/core/src/setups.ts:113-186`) parses `--info=progress2` into `{bytes, percent, rateBytesPerSec, etaSeconds}` but is consumed only by the wizard's staged-transfer engine, in-memory, never persisted. A placement-modal `sync-local`/`push` job shows a 400-line text ring (`job_output`), no percent bar, no ETA.
3. **The process can genuinely outlive cancel.** Verified traps:
   - Hub cancel is fire-and-forget: `jobs.cancel()` marks the row `canceled` immediately and ignores `sendToAgent`'s false-when-offline return (`apps/server/src/jobs-service.ts:364-390`) — a canceled-while-offline job leaves the detached modelctl child running with zero rows tracking it.
   - No cancel-ack frame exists (`agentServerMsgSchema`, `packages/core/src/job-messages.ts:225-237`); the only confirmation is an eventual `job-done`, which the terminal guard swallows after the premature cancel.
   - Agent crash mid-transfer orphans the detached child (`runStreaming` spawns `detached:true`, `apps/agent/src/modelctl.ts:547-560`); there is no jobId→pgid registry or re-attach (contrast setups, which persist pid/pgid). The hub reaper then marks the job failed while rsync keeps saturating the CX7/SMB link.

## Evidence (2026-10-29, three parallel code inventories + modelctl 0.23.0 source)

| Area | Fact | Where |
|---|---|---|
| Cancel plumbing | Route → frame → group-kill already complete | `app.ts:820-829` → `jobs-service.ts:364-390` → `transport.ts:369-371` → `jobs.ts:185-188` → SIGTERM/SIGKILL `modelctl.ts:589-603` |
| Cancel reachability | Sheet-only in ModelsView; `closeJob()` destroys the handle; NodeDetail op-bar exists (IRI-044) but is per-page state, lost on navigate/reload | `ModelsView.vue:730-735`; `NodeDetail.vue:833-856` |
| Jobs surface | `GET /api/v1/jobs?limit=` (all nodes, `lastLine`) exists; consumed only as Telemetry-feed seed; no jobs view in the router | `app.ts:802-809`; `router.ts:1-30`; `live.ts:241-263` |
| Progress wire | `job-progress` SSE carries one raw line, 1/s per job; no numeric fields | `packages/core/src/events.ts:100-108`; `index.ts:290-300` |
| Progress parsing | rsync parser exists, wizard-only, in-memory, never persisted to `stages` jsonb | `setups.ts:113-186`; `setups-service.ts:800-815` |
| modelctl suppression | `sync-local --jobs>1` → `_quiet_runner` captures output, `effective_progress = None`; push `--jobs 4` (IR-121 hub default) → `_run_rsync_streams` interleaves up to 4 progress2 streams on one pipe | modelctl `sync_queue.py:116-158`; `remote.py:280-307,377-392` |
| Staging residue | Interrupted transfers stay resumable in remote staging (push) / local staging (sync) — cancel is safe for the store but leaves staging garbage until hygiene reclaim | `remote.py:289-307`; `sync_queue` preflight |
| Mockup precedent | "Jobs" strip with per-row `.bar--lg` + rate + "~eta left" + "Cancel…" + "All jobs" already designed for Models pages | `mockups/models.html:89-110`; `mockups/models-downloads.html:121-142` |

## Plan

- [ ] Research: `docs/research/IRI-048-transfer-tracking-cancel-research-brief.md` — confirm the inventory above against HEAD; verify live on DEV (dispatch a small sync-local, close the sheet, hunt for it elsewhere; cancel with the node's WS up and with it down).
- [ ] Mockup: extend `mockups/models.html` Jobs strip to a persistent, cross-page transfer surface (see Shape below); light/dark browser-verified; owner pick on placement.

### Shape (proposed, owner to confirm)

- **A. Jobs strip on Models pages + persistent op bar (IRI-044 parity in ModelsView)** — smallest change; reuses the mockup design. ModelsView gets the NodeDetail compact bar; a new "Transfers" card lists active + recent `sync-local|push|download-queue|delete-local|register-local` jobs fleet-wide from `live.jobs` + `fetchRecentJobs`, rows clickable → sheet, per-row Cancel.
- **B. A + a global footer/topbar "Transfers (N)" affordance** opening the strip from anywhere (TelemetryDrawer-style dock). Survives all navigation; reload re-seeds from `GET /api/v1/jobs`.
- **C. Dedicated `#/transfers` route** with the full history table (params → model label via IR-121 `jobLabel`, node, elapsed via the already-existing `jobElapsed`, progress bar, cancel). Most durable, most surface.

### Backend / correctness work (independent of A/B/C)

- [ ] **Cancel must not lie.** Split `cancel()` into `canceling` state or verify-before-write: only mark the row `canceled` after the agent's `job-done {canceled}` (or a new `job-cancel-ack`); if `sendToAgent` returns false, return 409 "node offline — process may still be running" and leave the row running for the reaper. Add the ack frame to `agentServerMsgSchema` (wire-version tolerant: absent ack on old agents keeps today's behavior).
- [ ] **Persist progress for transfer jobs.** Parse `parseTransferProgress` in `jobsService.onOutput` for `sync-local|push` (the parser is already in core and already fed every line), persist `{bytes, percent, rateBytesPerSec, etaSeconds}` on the `jobs` row (migration: `progress jsonb`), and include it in the `job-progress` SSE frame so every surface renders a real bar without polling.
- [ ] **Aggregate multi-stream progress** (depends on modelctl): modelctl's download emitter already prints `progress: {json}`; extend the same emitter to `sync-local`/`push` (sum of streams, one aggregate line) so `--jobs 4` pushes report real totals instead of interleaved per-stream percents. Pin bump rides its own PR (IR-75 pattern).
- [ ] **Orphan reconciliation.** Agent: persist active-job `{jobId, pgid, kind, startedAt}` to `$IRORI_STATE_DIR` (the setups pattern), re-announce on hello; agent kill verb for a persisted pgid. Hub: hello hook checks whether a reported active job matches a `running` row, else settles it `failed` ("agent restarted; orphaned transfer killed/adopted").

### Deferred

- Cancel for a `queued` (not yet batched) download entry — remove() covers pending rows; only the rare running-batch window 409s.
- `agent-update` cancel (restart semantics; settlement is hello-driven by design, ADR-0007).
- Resume/re-dispatch of canceled transfers (staging is resumable at the modelctl layer; a UI "resume" is a new-job creation concern).

## Acceptance

- [ ] Start a sync-local or push from the placement modal, close every drawer/modal, navigate anywhere (including a full page reload): the running transfer is still visible with progress and a working Cancel.
- [ ] Cancel from the new surface stops the process: `job-done {canceled}` observed, `ps` shows no modelctl/rsync child on the source node, destination staging left resumable.
- [ ] Transfer rows show percent + rate + ETA (single-stream) instead of raw rsync lines; batched/multi-stream jobs show aggregate progress or an explicit "no progress available" state (never a misleading 16% of one stream).
- [ ] Canceling while the node's WS is down does NOT mark the row canceled without confirmation (409 or a `canceling` state; the reaper still settles it).
- [ ] Agent restart mid-transfer no longer strands the node: the job row is settled (not stuck `running`), and the orphaned child is killed or adopted and cancelable.
- [ ] `pnpm test` + `pnpm typecheck` + `pnpm build` + `.agentic/bin/validate` (python3.12) + `.agentic/bin/docs-check --base origin/main --strict` green; docs/API.md updated (new frame fields / ack / progress columns); ADR if the cancel-state change alters the wire contract.

## Notes

- Cancel of a batch `download-queue` job already cascades to every entry (`settleBatch` canceled branch) — the new surface must state that blast radius (the confirm copy in `ModelsView.vue:504-522` is the model).
- Push remediation (ADR-0014) re-creates pushes with `_remediated: true`; progress parsing must not break that flow (it only reads output lines).
- Staging residue from canceled transfers is reclaimed by the existing `cleanup-staging`/hygiene work (IRI-047 line); the confirm copy should say so.
- The partial unique index `jobs_node_active_uq` means the node's one-active slot frees the moment cancel writes `canceled` — the premature-marking fix must keep the slot held until terminal (state-machine change, not just display).
