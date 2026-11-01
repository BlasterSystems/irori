# Task: IRI-063 - poll truth defers to the probe; stop always forwarded

Jira **IR-151** (Part A of the IRI-053 brief; Part B — Serve page UX — is
IR-152). A recipe that daemonizes the engine (`docker run -d` + readiness
wait, script exits 0) leaves the engine outside the recorded process group.
The agent's driver-truth poll computes liveness as pgid-alive only, so it
reported `stopped` while the engine was serving; the hub demoted the row to
`stopped`/null (the old "polls never promote via the probe" rule) and `tick()`
never re-probes stopped rows — permanently wrong. The UI then hid Stop
(stopped rows), and hub `stop()` early-returned a silent no-op, so the owner
could not stop the live engine (live evidence 2026-10-31, setup 474c2800:
running/healthy → stopped/null 1.6 s apart, engine serving at decodeTps 35-87).

## Change

- `apps/server/src/setups-service.ts`:
  - `onDriverEvent` poll-reported `stopped` (`exitCode === null`) now consults
    `latestPortSnap(headNodeId, port)`: declared engine answering → keep/restore
    `running`/`healthy` (clears the stale lastError, mirroring `evaluateHealth`);
    a different engine → `running`/`foreign`; only nothing-answers demotes.
    The start's own exit (`exitCode` set) keeps its old promote-only-on-match
    rule — unchanged.
  - Stop grace: `stopSettledMs` map stamped by `updateRow` on every
    `status: "stopped"` settle, cleared on a fresh `starting`. A poll inside
    the 30 s window always demotes — the node's probe (2 s cadence default)
    may still hold the pre-kill snapshot; without the grace a stop would
    flicker back to healthy.
  - `stop()` no longer early-returns for `stopped` rows: forwards the
    `setup-stop` frame regardless of row status. The agent's no-record nack
    ("setup is not running") from a was-stopped row settles clean (no bogus
    lastError); offline still `SetupOfflineError`.
- `apps/web/src/serve.ts`: pure `probeSeesEngine(setup, headLlm)` —
  declared engine detected on the declared port via `modelIdMatches`.
- `apps/web/src/components/ServeView.vue`: the card renders Stop when
  `probeSeesEngine` is true, not only for starting/running rows — the row's
  (possibly false) status never hides the only control that kills a live
  engine.
- `docs/API.md`: Setups section documents both rules.

## Out of scope (ticket)

- Serve-page restructure (IR-152); start pre-flight (IRI-023 §9, owner
  decision pending); recipe contract docs; the optional agent-side
  `reportStatus` engine verification (follow-up).

## Verification

- `apps/server/test/setups.test.ts` (3 new): (1) start → own-exit-0 promote →
  poll-stopped with the declared model answering stays running/healthy; a
  different engine → foreign; nothing answering → demoted. (2) stop settles
  while the probe still reports the engine → the next poll must NOT promote
  (grace). (3) stop on a never-started row really sends the frame, the
  no-record nack settles clean, offline throws. The pre-existing
  demotion-on-no-answer path stays green (its ring says detected:false).
- `apps/web/test/serve.test.ts`: `probeSeesEngine` truth table (match / wrong
  port / foreign / not-detected / null snapshot / absent node).
- Full workspace: 861 green (core 100, proxy 24, web 300, db 5, agent 199,
  server 233); build, typecheck, validate, docs-check pass.
- Live proof: daemonizing recipe on DGX-1 stays running across the 15 s poll
  and Stop kills the docker ranks — rides the next dev tag.

## Risks

- A stopped-forever engine whose port still answers (hung container) now
  reads running/healthy — truthful per the documented "probe is the source of
  truth for health" rule; Stop (and the driver record's group fallback)
  remain the kill paths.
- 30 s grace is one hub-clock constant: a poll arriving after a real kill
  within the window demotes correctly; after the window the probe has
  refreshed (2 s cadence) and truth stands.
