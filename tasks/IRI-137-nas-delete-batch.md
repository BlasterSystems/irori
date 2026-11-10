# Task: Agent job kind `nas-delete-batch` (S1 of epic IR-207)

## Objective

Add an agent-side batch job kind `nas-delete-batch` that deletes several models from the NAS store in one job, running the exact same per-model plan → preflight → apply sequence as `nas-delete-apply`, emitting one structured line per model plus a final JSON summary, and never letting one failed model stop the batch.

## Product manager summary

- **One-liner:** One hub job deletes N models from the store instead of N serialized jobs.
- **User value:** Bulk cleanup (4.6 TiB-class) becomes a single audited operation with per-model progress instead of 76 job rows.
- **Business impact:** Disk-pressure response time drops from ~1 h of serialized jobs to one job; the 2026-11-10 out-of-band batch becomes repeatable via UI (IR-210).
- **Success metric:** A batch job over a fake store deletes all models, reports per-model status, and a single failed model does not prevent the rest from deleting.
- **Dependencies & constraints:** Follows the destructive-kinds convention (ADR-0004: every mutation via modelctl). Hub allowlist + settle effects are IR-209 (S2); web bulk action IR-210 (S3); docs IR-212 (S5). Store must be `modelctl`-owned; agent is privileged — params validated before any exec.

## Acceptance criteria

- [ ] `nas-delete-batch` is a runner kind (`RUNNER_KINDS`) with a `main.ts` dispatch branch passing the same modelctl ctx as `nas-delete-apply`
- [ ] Params `{names: string[]}`; non-array/empty/non-string entries fail the job with a clear error line before any exec
- [ ] Per model: dry-run plan (`delete --json`), create+unlink preflight of every object/staging path, then `--apply --yes` (reuses `runNasDeleteApply`)
- [ ] One JSON output line per model: `{model, status: "deleted"|"failed"|"skipped", error?}`; invalid names and duplicates are `skipped` without invoking modelctl
- [ ] A failed model does not stop the batch (later names still attempted)
- [ ] Cancel mid-batch: remaining names marked `skipped` with `canceled before delete`, job fails
- [ ] Final JSON summary line: `{kind:"nas-delete-batch", total, deleted, failed, skipped, results}`
- [ ] Job `ok` only when every name ended `deleted` (zero failed, zero skipped — drives hub-side red visibility + catalog re-read)
- [ ] Tests: kind pin, happy path, partial failure continues, preflight denial continues, invalid/duplicate skip, summary shape

## Scope

### Included

- `apps/agent/src/delete-preflight.ts`: richer `runNasDeleteApply` return (`{ok, error?}`, backward compatible) + new `runNasDeleteBatch`
- `apps/agent/src/main.ts` dispatch branch, `apps/agent/src/jobs.ts` runner-kind entry (exported for the pin test)
- `apps/agent/test/delete-batch.test.ts` with a fake modelctl binary (mirrors `delete-preflight.test.ts` stubbing)

### Excluded

- Hub allowlist / `CATALOG_MUTATING_KINDS` / settle tests — IR-209
- Web bulk-select UI — IR-210
- API.md/SPEC.md documentation — IR-212 (the kind is not hub-dispatchable until S2 ships, so documenting it now would be wrong)
- Staging prune, free-space floor — IR-211 / IR-213

## Plan

- [x] Understand requirements and inspect relevant code (delete-preflight.ts, jobs.ts JobManager, main.ts dispatch, modelctl.ts buildCommand, delete-preflight.test.ts stubbing, modelctl plan JSON shape)
- [x] Confirm architecture impact — none new; ADR-0004 flow reused
- [x] Implement the smallest complete change
- [x] Add or update tests
- [ ] Update documentation — deferred to IR-212 by design
- [x] Run validation

## Architecture impact

- **ADR required:** No — follows the established destructive-kinds + ADR-0004 modelctl-ownership decision; no data-model, deployment, or integration-boundary change.
- **Relevant ADRs:** ADR-0004 (store stays modelctl-owned)

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — "Configuration validation passed"; `.agentic/bin/docs-check --base origin/main --strict` — pass (CI docs-check green)
- Tests: new `apps/agent/test/delete-batch.test.ts` (7 tests: kind pin, happy path + summary shape, plan-failure continues, preflight-denial continues [skipIf root], invalid/duplicate skip, malformed params rejected pre-exec, pre-aborted cancel); full `pnpm -r test` green (server 47/47 incl. db-gated job-events, agent 22 files, web 58, proxy 4, db 3)
- Build/typecheck: `pnpm -r build` exit 0; `apps/agent` `tsc --noEmit` exit 0 after fix — first CI verify run caught `chmodSync(dir, mode, {recursive})` (unsupported options arg in @types/node 24.19.2; vitest/esbuild had masked it), fixed in 9f09740 by restoring perms explicitly per the existing test convention; CI verify green 4m54s
- Documentation check: pass; API.md/SPEC.md intentionally untouched until IR-209 makes the kind hub-dispatchable (IR-212 documents)
- Live smoke: esbuild/tsx one-off driving the real `JobManager.start("nas-delete-batch")` → `runNasDeleteBatch` with a scripted modelctl — observed per-model JSON lines, final summary `{kind, total, deleted, failed, skipped, results}`, `DONE: succeeded exit 0`, ordered apply log; throwaway deleted

## Review

- Correctness: batch reuses `runNasDeleteApply` per name (plan → create+unlink probe → `--apply --yes`), so IRI-028's model-left-active guarantee holds per model; a failed model emits its reason and the loop continues; cancel marks the remainder `skipped: canceled before delete`; job green only when every name ended `deleted` (skipped/failed → red → hub catalog re-read on settle)
- Security: params validated before any exec (string array, per-name `MODEL_NAME_RE`); mutation only via `buildCommand` argv; runner-kind allowlist extended, no new exec surface
- Compatibility: unreachable until the hub allowlists the kind (IR-209); new agent + old hub is a no-op (hub never dispatches unknown kinds)
- Residual risks: per-model detail lines make long batches verbose (audit-trail parity, accepted); `skipped` semantics are batch-level (not "absent from store" — a missing manifest surfaces as `failed` with modelctl's wording, matching the single-delete path)
