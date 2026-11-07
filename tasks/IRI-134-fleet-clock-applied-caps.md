# Task: Applied cap values in fleet clock outcome rows

Jira **IR-199** (Task, Medium, sprint 998). Follow-up from the IR-198 review —
the row treatment itself shipped in IRI-133 with `side: ok|error` details
because the API carried no applied value. Mockup:
`mockups/IRI-130-mobile-shell-clock-options.html` S7/S8.

## Objective

`POST /api/v1/clock-cap` returns the applied cap MHz per side, and the
Overview's fleet clock caps outcome rows render `GPU 2000 · CPU 2000` for ok
sides (mockup S7/S8 idiom) instead of `gpu: ok · cpu: ok`, keeping the API
error text for failed sides.

## Product manager summary

- **One-liner:** fleet clock outcome rows show the cap that actually applied, per side.
- **User value:** an operator sees at a glance which ceiling landed on each node (`GPU 2000 · CPU 2000`) instead of an uninformative `ok`.
- **Success metric:** after a fleet apply, each row names the applied MHz per side; cleared and failed sides stay distinguishable.
- **Dependencies & constraints:** server and web ship in the same tag (next: `dev-0.6.0-5`); no agent change — the hub sends the cap and the agent either applies it or reports an error, so the requested value is the applied value by construction.

## Acceptance criteria

- [ ] `POST /api/v1/clock-cap` results carry the applied cap MHz per side: the requested value for an applied side, `null` for a clear or a failure; unrequested sides produce no entry
- [ ] Overview outcome rows render `GPU <MHz>` / `CPU <MHz>` for ok sides and `<side> failed — <error>` for failures
- [ ] Server clock-caps test (200/207/502) extended; `overview-fleet-clock-ir198.test.ts` row assertions updated
- [ ] 200/207/502 semantics and the `fleetError` banner unchanged

## Scope

### Included

- `apps/server/src/app.ts` — `applyClockCaps` result entries (+ fleet route pass-through type)
- `apps/web/src/api.ts` — `FleetClockCapNode.results` type
- `apps/web/src/components/OverviewView.vue` — `fleetOutcomeText`
- `apps/server/test/clock-caps-ir189.test.ts`, `apps/web/test/overview-fleet-clock-ir198.test.ts`

### Excluded

- Agent wire change: `clocks-set-result` stays `{ok, error}` (no frame change)
- NodeDetail clock cards and drift UI (untouched per IR-198 option A)

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact — none (additive response field + presentation)
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** No — additive API field, no data-model, deployment, or integration-boundary change.

## Validation evidence

- **Typecheck + tests + build:** full gate (typecheck → `pnpm test` → `pnpm build` → `.agentic/bin/validate` → `.agentic/bin/docs-check`) **EXIT=0**; docs-check: 7 changed files, no heuristic gaps. Web 58 files green (extended `overview-fleet-clock-ir198.test.ts`); server 28 files green incl. the new set-vs-clear applied test; `power-ir68.test.ts` had two pre-existing exact-shape pins on the per-node PUT `results` array — updated to the new field (behavior change is the ticket).
- **Live smoke (real server + fake agent over the real WS, fresh PG, port 3948):** `POST /api/v1/clock-cap {capMHz:2000, cpuCapMHz:2800}` → 200 `results:[{side:gpu,ok,appliedMHz:2000},{side:cpu,ok,appliedMHz:2800}]`; `{capMHz:null, cpuCapMHz:null}` → 200 with `appliedMHz:null` on both sides; refusing agent (`ok:false` on the clocks-set-result frame) → HTTP 502 with `appliedMHz:null` + error text preserved.
- **Real browser (built SPA served by the smoke server, 390 px):** picking 2000/2800 MHz and Apply renders the row `smoke GPU 2000 · CPU 2800` with status `applied on 1/1 nodes`; no result chips; zero console errors (screenshot verified).

## Review

- **Correctness:** `appliedMHz` is the requested cap for ok sides — the agent applies the frame value or refuses (`reply.ok` gates the registry write), so requested = applied by construction; `null` on a clear or a failure; sides left alone produce no entry. The fleet route passes entries through untouched; the per-node PUT failure body carries the same field (its exact-shape pins were updated).
- **Security:** response field only — no new route, no secrets, no store change; the agent surface is untouched.
- **Compatibility:** additive JSON field; server and web ship in one tag (`dev-0.6.0-5`). No agent change → no fleet rollout.
- **Residual risks:** `appliedMHz` mirrors the requested cap, not a driver read-back — a driver-side clamp would surface via the existing `clock_cap_drift` rule, as today. A cleared side renders `CPU cleared` (no mockup example exists for that state; matches the status-line idiom).
