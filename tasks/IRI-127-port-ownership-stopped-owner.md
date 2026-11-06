# Task: IRI-127 — port ownership keeps a stopped owner (IR-191)

Jira **IR-191** (Bug, High). Regression class first seen in the IR-155 fix.

## Objective

A setup start was refused with 409 while the head port was free. The event
journal shows a sibling row promoted to `running` 4 s after the real owner was
stopped, then demoted 15 s later — the phantom status blocked the start.

## Root cause

`portRival()` (`apps/server/src/setups-service.ts`) only counts **live**
siblings. When the true owner's row is stopped while its engine is still
winding down (the probe snapshot can predate the stop), the driver-truth poll
(`onDriverEvent`, `exitCode === null`) sees no live rival and promotes a
stopped sibling from the still-fresh snapshot. `liveRivalOnPort()` then refuses
the next start on that port.

Journal evidence (DEV, 2026-11-06):

- 21:43:03.091 `abe7adc3` (real owner) stopped; capture proxy closed 21:43:04.473.
- 21:43:07.423 `474c2800` (sibling, stopped since 21:30:42) promoted to running/healthy.
- 21:43:19.995 start of `a10d0499` → 409.
- 21:43:22.412 sibling demoted; retry at 21:44:26 succeeded.

The same churn repeats at 19:08, 19:15, 19:26, 19:31, 21:18, 21:34, 21:43.

## Acceptance criteria

- [x] The most recent start owns the port regardless of the sibling's current
      status: a stopped owner still owns it while its engine winds down.
- [x] The web `portRival` mirrors the server rule (its comment says it does).
- [x] Server regression test: owner started later and stopped, sibling poll
      must not promote.
- [x] Web test updated: a stopped sibling that started later outranks.

## Scope

- `apps/server/src/setups-service.ts`: `portRival` drops `isLiveStatus`.
- `apps/web/src/serve.ts`: same rule in the mirrored helper.
- `apps/server/test/setups.test.ts`, `apps/web/test/serve.test.ts`.

Not in scope: the start guard's status filter (`liveRivalOnPort` stays
live-only — a start right after a stop still races the port release, and the
agent reports that clearly).

## Verification

- `pnpm --filter @irori/server test` with `IRORI_TEST_DATABASE_URL`.
- `pnpm --filter @irori/web test`.
- Live: start a sibling while the previous owner's row is stopped but its
  engine is still winding down — no phantom `running` chip, no 409.
