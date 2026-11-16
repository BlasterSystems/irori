# Task: Transfers dock — clear history for settled jobs (IR-262 / IRI-148)

## Objective

The Transfers dock's Earlier list is the hub's settled-jobs feed (Postgres
`jobs` table) and could only grow: no clear control, no DELETE route, no
retention anywhere (rows leave only via the node-deletion cascade). Operator
ask 2026-11-16: be able to clean the recent history. Owner decisions at the
round-15 gate: clear = ALL settled jobs (every kind — the dock shows
hygiene/staging audits too), one-click without arm-confirm (IR-026
auto-clear precedent is the download_queue store, a different surface).

## Product manager summary

- **One-liner:** a Clear history button in the dock footer wipes every settled job row server-side and re-seeds the dock.
- **User value:** the "recent downloads" list is cleanable without touching Postgres.
- **Success metric:** click Clear history → the Earlier section empties; queued/running transfers and Cancel keep working.
- **Dependencies & constraints:** none. Research: `tasks/research-feedback-round15.md` (round-15, owner-approved).

## Acceptance criteria

- [x] `DELETE /api/v1/jobs` removes only settled rows; queued/running rows and the active slot are untouched (partial unique index intact).
- [x] `job_output` cascades; `download_queue.job_id`/`cleanup_runs.job_id` go NULL (schema FKs) and consumers still render.
- [x] Route audited (`jobs.clear-history`); `503` while degraded.
- [x] Dock footer button (only when settled rows exist) clears and the Earlier section empties after the re-seed; no button without settled rows.
- [x] Tests: db-integration semantics against a dedicated throwaway database + route contract + web mount tests.

## Scope

### Included

- `apps/server` — `JobsService.clearHistory()` (settled-only delete with returning count) + the audited `DELETE /api/v1/jobs` route.
- `apps/web` — `clearJobs()` helper, dock-footer button + `clearHistory()` (`clearJobs()` → `live.refreshJobs()`), footer flex layout.

### Excluded (rejected at the gate)

- New SSE `jobs-cleared` frame (core schema + ingest-arm churn; the dock is the only settled-history surface — other tabs refresh on the next job frame or reload).
- Auto-retention/TTL; per-entry dismiss.

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** No — one route + one store method + a footer button; no schema change (row deletion only; existing FK behaviors reused as-is).

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed
- Tests: `IRORI_TEST_DATABASE_URL=…54329 pnpm -r test` — 1434 passed, 0 failed (server 431, web 530 incl. the two new suites). `pnpm -r typecheck` — 6× Done.
- Build: `pnpm -r build` — green
- Documentation check: `.agentic/bin/docs-check` — no gaps; `docs/API.md` job-activity section documents the route; CHANGELOG Unreleased Added entry.

## Review

- Correctness: the delete is `status IN (succeeded, failed, canceled)`; the one-active slot (partial unique index `jobs_node_active_uq`) can never be deleted out from under a running job. The suite runs against a dedicated throwaway database because the deletion is global by design — the shared-DB fixture rule forbids whole-table deletes against the shared test database.
- Security: audited like `job.cancel`; no new secrets or surfaces.
- Compatibility: `download_queue.job_id`/`cleanup_runs.job_id` are `ON DELETE SET NULL` — both views render with NULL (schema-level FK behavior, asserted in the db-integration test).
- Residual risks: other browser tabs keep stale rows until their next `job` frame or reload (cosmetic, accepted at the gate); the deleted job output rings are unrecoverable (the clear itself is audited).
