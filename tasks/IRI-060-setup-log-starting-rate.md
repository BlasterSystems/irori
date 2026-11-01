# Task: IRI-060 - shared-feed setup-log throttle relaxes while starting

Jira **IR-148**. S2 of IRI-052 (engine log telemetry feed). IR-124 capped the
shared-feed `setup-log` emission at 1 frame/s per setup unconditionally
(`emitSharedSetupLog`, `apps/server/src/setups-service.ts`), with identical
consecutive lines skipped. Weight loading — the densest, most interesting
engine-output phase — therefore collapsed to 1 line/s in the Overview Telemetry
feed while the ServeView panel (per-setup log stream, unthrottled) got full
fidelity.

## Change

- `setups-service.ts`:
  - `statusBySetup` mirror + `statusOf()` (DB hydrate on miss, so a hub
    restart mid-start keeps the fast rate; `updateRow` is the single status
    write path and mirrors every write).
  - `emitSharedSetupLog` picks the throttle window from the hub row status:
    `FEED_LOG_MIN_MS_STARTING` = 100 ms (~10 fps) while `starting`,
    `FEED_LOG_MIN_MS_RUNNING` = 1000 ms otherwise. Identical-line dedup stays
    unconditional. The ticket's "needs access to the row's driver state" —
    the mirror answers without a per-line DB read once warm.
  - `emitSharedSetupLog` now returns its promise and `onDriverLog` awaits it:
    the throttle state is read-then-write, and with two DB lookups in the
    chain a fire-and-forget could reorder concurrent lines under load. The
    WS dispatch site already swallows via `.catch(() => {})` in `index.ts`.
- `docs/API.md`: SSE `setup-log` contract updated (running 1 fps, starting
  ~10 fps).

## Out of scope

- ServeView panel stream (`attachLog`) untouched — never throttled.
- Web ring cap (300) and live-only semantics (no backfill) unchanged.

## Verification

- `apps/server/test/setups.test.ts`: new test drives
  `onDriverEvent {state:"starting"}` → 6 distinct lines at ~115 ms spacing →
  ≥5 emitted (old cap: 1); identical repeat still deduped at the fast rate;
  probe-healthy → `running` → 1 fps cap resumes (second distinct line inside
  the window suppressed, emitted after 1.1 s). Real delays per the IR-124
  test's documented embedded-Postgres/fake-timers constraint.
- Full workspace gate green (see below).
- Live proof rides the next dev tag: feed shows multi-line bursts during
  weight load.

## Evidence

- Server suite 230/230; the IR-124 test unchanged and still passing — the
  running-state path keeps its 1 fps behavior.
- Full workspace: 855 green (core 100, proxy 24, web 299, db 5, agent 197,
  server 230); build, typecheck, validate, docs-check pass.

## Risks

- One extra map entry per setup (`statusBySetup`) — same lifetime pattern as
  `headBySetup`/`nameBySetup`; no new tables or agent changes.
- A bursty engine at exactly 10 fps could pin the relaxed cap for the whole
  starting window; bounded by the web ring (300) and the live-only design.
