# Task: IRI-065 - one live setup per head port; probe truth attributes the port to one row

Jira **IR-155**. Found during the dev-0.4.0-2 fleet rollout (2026-11-02, live
evidence on DGX-1): `GLM-Flash-TP2-MIIA` and `GLM-Flash-TP3-MIIA` both declared
DGX-1 `:8081` + GLM-5.3. IR-151 made the probe the source of truth for health,
but the probe can only say *an* engine answers that port — not who started it.
So after TP2 started, TP3 (`lastStartedAt: null`, its recipe never ran) was
promoted to `running`/`healthy` by the same snapshot, while exactly one
container (`glm53-flash-tf`) existed. The phantom row is not cosmetic: the card
renders Stop for a `running` row, and its `scriptStop` is the shared recipe's
`stop.sh`. The agent only runs that script when its driver holds a record — a
never-started row answers the harmless nack (live proof: stopping TP3 returned
`setup is not running` and TP2's engine survived) — but as soon as the phantom
has a retained record (started once, engine then died) Stop kills the sibling's
live engine, and nothing but the owner's `lastError` explains which row was real.

## Change

- `apps/server/src/setups-service.ts`:
  - `portRival(row)` — the ownership rule: a row that never started owns
    nothing; among live (`starting|running|stopping`) siblings on the same
    `(headNodeId, port)`, the one started most recently owns it.
  - `evaluateHealth` and the `onDriverEvent` poll-stopped branch consult
    `portRival` before trusting the probe. A row the rival owns is reported
    `stopped` with `port <p> is served by "<rival>" — this setup's own engine is
    not running`, never promoted to `running`/`healthy`/`foreign`. The owner's
    IR-151 promotion (and the stop grace) is untouched.
  - `ensurePortFree` guards `create()` and a port-changing `patch()` with
    `SetupInvalidError` (400) naming the holder — two engines cannot bind one
    port, so the config is invalid by construction. `start()` refuses the same
    situation with `SetupStartError` (409) for rows that predate the guard.
- `apps/web/src/serve.ts`: pure `portClashMessage(setups, draft, nodeName)` —
  the same live-status rule for the wizard, so the 400 is never a surprise.
- `apps/web/src/components/ServeView.vue`: the port field shows the clash
  (`.input--invalid` + `.field-error`) while typing. An engine answering with no
  setup owning the port is deliberately NOT reported — adopting an unmanaged
  engine is the intended flow.
- Client-side mirror of the same rule (the chip path had the identical defect,
  visible in the browser check: three cards read `SERVING :9180` for one engine):
  - `serve.ts`: `portRival` / `ownsProbePort` (same ownership rule as the hub),
    and `runningEnginesFromProbes` attributes a port's engine via
    `pickPortOwner` instead of the first matching row.
  - `ServeView.vue`: `probeSees()` gates chips and node lines on ownership;
    `canStop()` keeps Stop for any row that has actually run and whose port
    answers — hiding the only control that kills a live engine would strand it
    when the heuristic picks the wrong one of two live siblings.

## Out of scope

- The agent-side proxy leak (IRI-066 / IR-156).
- A dedicated "which setup owns this port" API/UI affordance; the row's
  `lastError` carries the owning setup's name.

## Verification

- `apps/server/test/setups.test.ts` (2 new, db-gated): (1) a live holder blocks
  a duplicate create (400) and a port-colliding patch (400, row unchanged), the
  pre-guard sibling cannot start (409 naming the holder), and once the holder is
  stopped the port is free again. (2) both siblings created stopped, owner
  started + promoted, then the never-started sibling's driver-gone poll and
  `tick()` must keep it `stopped`/null while the owner keeps
  `running`/`healthy`.
  Fail-before confirmed by disabling each guard: the duplicate create is accepted
  and the phantom is promoted to `running`.
- `apps/web/test/serve.test.ts`: `portClashMessage` truth table — live statuses
  warn; stopped/failed siblings, another head, another port, a bad port and the
  row being edited stay quiet.
- Workspace: typecheck, build, `.agentic/bin/validate`, `.agentic/bin/docs-check`
  pass; agent 203, web 313, server (db-gated, disposable PG) green.

## Risks

- Existing fleets may already hold colliding rows: they keep working (the start
  guard only refuses a *second* start onto a live port) and their phantom row
  demotes itself on the next poll with the owner named. Moving a row off the
  collision is the owner's call — the platform no longer invents a second
  "running" for one engine.
- Ownership among *two live* rows is last-start-wins, which is the best
  available signal without a per-run engine token.
