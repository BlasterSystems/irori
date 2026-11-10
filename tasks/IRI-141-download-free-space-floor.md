# Task: Free-space floor for store downloads (S6 of epic IR-207)

## Objective

Downloads must fail fast — at job start — when the destination store volume's free space is below a configurable floor (default 1.5 TiB), naming the measured free space and the threshold.

## Product manager summary

- **One-liner:** No more downloads into a nearly-full pool.
- **User value:** The 2026-11-09 incident (downloads pushed pool 2 to 82%) cannot recur silently.
- **Business impact:** Protects the unredundant pool from fill-by-download; the failure names the remedy.
- **Success metric:** A download job on a store below the floor fails in the agent before any modelctl write, with the measured numbers in the output.
- **Dependencies & constraints:** The per-file check belongs in modelctl's download path (upstream follow-up); this slice implements the agent-side job-start gate from the agent's own telemetry (snapshot-fresh, no new I/O in the job path).

## Acceptance criteria

- [x] `download` and `download-queue` jobs fail at start when the store's free bytes (latest snapshot, nasRoot mount) are below `IRORI_MIN_STORE_FREE_BYTES`
- [x] Unknown telemetry (null) or a disabled floor (0) never blocks (fail-open by design — the floor is a guard, not the store's truth)
- [x] The failure line names the measured free space, the floor, and both remedies (free space / lower the env)
- [x] Floor configurable via `IRORI_MIN_STORE_FREE_BYTES` (default 1.5 TiB, documented in CONFIGURATION.md)
- [x] Tests: below-floor fast-fail without invoking modelctl, download-queue parity, proceed cases (above floor / null telemetry / disabled floor), config defaults

## Scope

### Included

- `apps/agent/src/jobs.ts` floor gate (JobCtx fields + STORE_FLOOR_KINDS), `apps/agent/src/config.ts` env, `apps/agent/src/main.ts` telemetry wiring, `apps/agent/test/download-floor.test.ts`, CONFIGURATION.md

### Excluded

- modelctl per-file floor (upstream follow-up: the download path should re-check statfs before each large file write and abort cleanly) — to be filed against the modelctl repo; the agent gate covers the job boundary meanwhile

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [ ] Run validation

## Architecture impact

- **ADR required:** No — a guard on the existing job path; no boundary or data change.
- **Relevant ADRs:** ADR-0004 (store stays modelctl-owned)

## Validation evidence

- Gates: `pnpm -r build` 0 · `pnpm -r typecheck` 0 · db-gated `pnpm -r test` 0 (agent 24 files incl. the new suite, server 47/47 with the db, web 58, core 12, db 3, proxy 4) · `.agentic/bin/validate` 0 · `docs-check --base origin/main --strict` 0
- Tests: `apps/agent/test/download-floor.test.ts` — below-floor fast-fail with zero modelctl invocations (log file untouched), download-queue parity, proceed cases (above floor / null telemetry / disabled floor), config default + env override + invalid-env fallback; the completion signal is the real onDone event (deferred, no timer polling)

## Review

- Correctness: the floor reads the agent's own snapshot telemetry (mount-matched to nasRoot, refreshed every cadence tick) so the check is synchronous and adds no I/O to the job path; a stale snapshot is at most one cadence old (2 s default)
- Security: no new surfaces; the refusal message carries no secrets
- Compatibility: agents without the floor keep old behavior (the hub does not gate); the env default preserves current fleet behavior until the pool is actually low
- Residual risks: fail-open on unknown telemetry (by design — a blind guard must not brick downloads); the per-file check remains an upstream modelctl follow-up
