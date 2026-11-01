# Task: IRI-059 — setup-log frames reach the web live store

Jira **IR-147**. Follow-up defect on IR-124 (Done): the hub side shipped
complete but the web ingest arm was never implemented, so every throttled
engine-output frame was silently dropped and the existing renderer was dead
code. Spec home: `docs/research/IRI-052-engine-log-telemetry-feed-research-brief.md`.

## Objective

While a serving setup starts, the engine's own output (weights-loading lines,
`AVG decode … tok/s`) should stream into the shared Overview Telemetry feed /
TelemetryDrawer, as documented (API.md "SSE `setup-log`", ARCHITECTURE.md
"Setup engine output joins the same feed"). The hub emitted the throttled
frames (`setups-service.ts` `emitSharedSetupLog`), the wire schema carried the
variant (`packages/core/src/events.ts` `setupLogEventSchema`, in the
discriminated union), and the renderer case existed
(`apps/web/src/overview.ts` `feedLines` `case "setup-log"`) — but the
`createLiveStore` ingest switch had no `setup-log` arm, so the frame parsed,
matched no case, and vanished.

## Acceptance criteria

- [x] A `setup-log` frame arriving over `/api/v1/events` enters the feed ring
      and renders as `<node> · <setup name>: <line>`.
- [x] Live-only semantics preserved (IR-124 non-goal): no backfill — a drawer
      opened mid-load shows the next throttled line; `GET /api/v1/setups/:id/log`
      remains the backfill source.
- [x] `pnpm -r test` and typecheck green.

## Scope

### Included

- `apps/web/src/live.ts`: `setup-log` case in the ingest switch (rides
  `pushEvent` like `thermal`/`setup-state`/`setup-transfer`).
- Test: `apps/web/test/live.test.ts` — emitted frame grows the ring, keeps
  the payload fields, and the previously-unreachable `feedLines` renderer
  produces the expected line.

### Excluded

- Hub changes (complete per IR-124), ServeView's per-setup log panel (separate
  `GET /api/v1/setups/:id/log` stream; working), backfill, dedup client-side
  (the hub already skips identical consecutive lines and throttles ≤1/s).

## Plan

1. Add the missing ingest arm.
2. Regression test at the store level (emit → ring) plus the renderer
   assertion (ring → line) so the dead-code path stays alive.

## Architecture impact

- **ADR required:** No — restores the documented frame flow.
- **Relevant ADRs:** none new (IRI-013 feed ring, IR-124 non-goals stand).

## Validation evidence

- Web suite: 299 green (new test emits a `setup-log` frame and asserts both
  the ring entry and the rendered `spark2 · glm-main: loading weights shard
  3/4` line — proving ingest and the renderer end-to-end).
- Full workspace gates: see PR.
- Live: engine lines appear in the Overview Telemetry feed while a setup
  starts; rides the next dev tag.

## Review

- Correctness: the union already admitted the frame, so the only change is
  routing it into the ring; ring cap/throttle semantics unchanged.
- Compatibility: no schema/wire change; older hubs that never emit the frame
  are unaffected.
- Residual risks: none identified — worst case a flood is bounded server-side
  (≤1/s per setup) and by the 300-entry ring cap.
