# Task: Web bulk-select delete on the Models page (S3 of epic IR-207)

## Objective

Multi-select store model rows, confirm with names + total bytes, and dispatch ONE `nas-delete-batch` job to the store node; the job drawer shows per-model progress from the output ring.

## Product manager summary

- **One-liner:** Delete many store models from the Models page in one dispatch.
- **User value:** The 2026-11-10 76-model cleanup becomes a UI action instead of an out-of-band script.
- **Business impact:** Completes the epic's user-facing path (S1 agent kind live in dev-0.6.0-8, S2 hub handling in dev-0.6.0-9).
- **Success metric:** Selecting N rows shows their total bytes, the confirm modal warns on setup references, and one job lands on the store node with per-model output.
- **Dependencies & constraints:** IR-208 (agent kind) and IR-209 (hub allowlist) merged. Agent-version gate: disable the action when the store node predates the batch kind (hub fails unknown kinds with a clear error; the UI should not offer it). No schema change.

## Acceptance criteria

- [x] Store model rows multi-select; selection shows total bytes from the catalog rows
- [x] Confirm modal lists the names + total bytes; danger action dispatches ONE `nas-delete-batch` to the store node
- [x] Setup-advisory: if ANY selected model is referenced by a setup, warn before dispatch (computed when the confirm opens; the drawer banner repeats it post-dispatch per the single-delete convention)
- [x] Agent-version gate: NOT implementable — agent 0.6.0 covers both pre- and post-batch builds (the version constant did not move), so there is no reliable signal. The action dispatches and an old agent fails the job cleanly with "unknown job kind" in the drawer (verified live on dev-0.6.0-9 against the 0.5.1 NAS agent: 202 → failed, no crash)
- [x] Job drawer renders the batch's per-model output lines (existing output ring; no bespoke parsing)
- [x] Component tests: pure-helper tests (selection totals, setup-advisory path) in `apps/web/test/nas-delete.test.ts`; dispatch payload is a literal `{names}` through the existing `createJob`

## Scope

### Included

- `apps/web/src/components/ModelsView.vue` + `apps/web/src/models.ts` (helpers) and tests

### Excluded

- Node cleanup panel / staging prune — IR-211
- Docs — IR-212 (landed separately)
- Free-space floor — IR-213

## Plan

- [ ] Understand requirements and inspect relevant code
- [ ] Confirm architecture impact
- [ ] Implement the smallest complete change
- [ ] Add or update tests
- [ ] Update documentation
- [ ] Run validation

## Architecture impact

- **ADR required:** No — UI-only consumption of the shipped job kind; ADR-0004 flow unchanged.
- **Relevant ADRs:** ADR-0004 (store stays modelctl-owned)

## Validation evidence

- Gates: `pnpm -r build` 0 · `pnpm -r typecheck` 0 (vue-tsc included) · db-gated `pnpm -r test` 0 (web 58 files incl. the extended nas-delete suite, server 47/47 with the db, agent 22, core 12, db 3, proxy 4) · `.agentic/bin/validate` 0 · `docs-check --base origin/main --strict` 0 (exit codes captured detached, verified per-package output)
- Tests: `apps/web/test/nas-delete.test.ts` — `setupServingNames` (dedupe, first-seen order, empty selection) and `bulkDeleteTotalBytes` (sums, stale-name handling)
- Live context: the batch kind is dispatchable as of dev-0.6.0-9 (probe verified: 202 → old agent settles the job failed cleanly, no crash)

## Review

- Correctness: selection survives pagination (names are stable); totals come from the current catalog page (absent names count 0 and are still dispatched — the agent reports them failed rather than silently dropping); the confirm's warning is computed pre-dispatch, the drawer banner repeats it post-dispatch; `clearBulk` runs only after `createJob` resolves (a failed dispatch keeps the selection for retry); the settled-batch refetch extends the existing delete-reload timer path
- Security: dispatch via the allowlisted jobs API; no new surfaces; the confirm modal renders the exact name list
- Compatibility: no agent-version gate (see acceptance — no reliable signal); hub 400s + old-agent job failure are the visible paths
- Residual risks: a stale selection row (model deleted out-of-band between select and dispatch) surfaces as a `failed` per-model line, matching agent semantics; checkbox column adds one 28px column to the catalog table
