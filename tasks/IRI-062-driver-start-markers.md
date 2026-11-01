# Task: IRI-062 - driver marker lines for start attempts

Jira **IR-150**. S4 of IRI-052 (engine log telemetry feed). `SetupDriver.start`
pushed driver lines only for the cache-user and capture-proxy cases. A plain
start was silent until the engine printed, and a pre-spawn failure (e.g.
MODEL_PATH resolution) produced only the `setup-state` failed transition — the
feed showed no record that a start was attempted and no reason (live case:
setup 69916930).

## Change (`apps/agent/src/setups.ts`)

- `start()` pushes `driver: starting <scriptStart>` after the already-running
  guard (a refused duplicate start is not an attempt), before any validation.
- Every pre-spawn refusal — script executable checks, stop-script required,
  cache-user wrap resolution, MODEL_PATH resolution, capture-support, capture
  bind — routes through a local `startFailed` helper that pushes
  `driver: start failed: <error>` and returns the same `{ok:false, error}`.
- The hub's failed `setup-state` event still fires exactly once: it is driven
  by the server's nack-ack handling of the returned error (server suite
  covers that); the markers are log-ring lines only, no new frames.
- Spawn-error and script-exit paths keep their existing `driver:` lines.

## Out of scope

- Stop path unchanged (`driver: running stop script` already existed).
- Hub/web untouched — with IR-147 (ingest) + IR-148 (starting-rate) these
  lines reach the Telemetry feed on their own.

## Verification

- `apps/agent/test/setups.test.ts`: plain start emits `driver: starting
  <path>`; MODEL_PATH-resolution failure emits the `driver: start failed:
  MODEL_PATH resolution failed…` line, returns the error, and the driver
  never reports the run as running.
- Full workspace: 857 green (core 100, proxy 24, web 299, db 5, agent 199,
  server 230); build, typecheck, validate, docs-check pass.

## Risks

- One extra ring line per start attempt and per refusal — negligible; the
  feed is throttled hub-side.
- Frames stream immediately via the existing `onLog` wiring; only `nextSeq`
  freshness rides `persist()` (IR-149) — no new lifetime semantics.
