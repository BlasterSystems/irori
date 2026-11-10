# Task: Hub handling for `nas-delete-batch` (S2 of epic IR-207)

## Objective

Let the hub dispatch the agent's new batch delete kind and keep all derived state correct on settle: dispatch allowlist, catalog re-read on every settle (succeeded or failed), inventory drop, and per-name placement/cache-row pruning on a succeeded batch.

## Product manager summary

- **One-liner:** The hub accepts `nas-delete-batch` jobs and settles their side effects correctly.
- **User value:** The bulk delete dispatched from the UI (IR-210) works end to end; the Models cache self-heals during and after a batch.
- **Business impact:** Completes the bulk-cleanup path started in IR-208; disk-pressure response becomes a single dispatch.
- **Success metric:** A dispatched batch job settles with placements and cache rows pruned per name, and a failed batch still triggers a catalog re-read.
- **Dependencies & constraints:** Depends on IR-208 (agent kind, merged in dev-0.6.0-8). No DB migration. Old agents fail the kind cleanly (`buildCommand` default throws "unknown job kind" → job failed with that error line). Docs deferred to IR-212.

## Acceptance criteria

- [ ] `JOB_KINDS` / `jobKindSchema` (packages/core) accepts `nas-delete-batch` — this is the create-time dispatch allowlist
- [ ] `CATALOG_MUTATING_KINDS` (apps/server) gains the kind; `INVENTORY_MUTATING_KINDS` inherits it via the existing spread
- [ ] Succeeded batch settle: `node_models` rows dropped for this node per name; `model_meta` rows dropped for names no node still holds
- [ ] Failed batch settle: placements kept (existing convention), catalog-request still fired, inventory dropped
- [ ] Tests: core kind pin; job-events settle tests (succeeded pruning + failed re-read); service.create accepts the kind
- [ ] CI verify + docs-check green

## Scope

### Included

- `packages/core/src/jobs.ts` JOB_KINDS entry + pin test in `packages/core/test/core.test.ts`
- `apps/server/src/jobs-service.ts` settle membership + per-name settle branch
- `apps/server/test/job-events.test.ts` settle-effect tests

### Excluded

- API.md/SPEC.md documentation — IR-212 (S5, lands with the web slice)
- Web bulk-select action — IR-210
- Agent-side behavior — shipped in IR-208 (PR #106)

## Plan

- [x] Understand requirements and inspect relevant code (JOB_KINDS, jobs-service settle switch, catalog-frame pruning, job-events test patterns, old-agent unknown-kind failure path)
- [x] Confirm architecture impact — none; extends existing job-kind tables and the IRI-018 cache-row convention
- [x] Implement the smallest complete change
- [x] Add or update tests
- [ ] Update documentation — deferred to IR-212 by design
- [x] Run validation

## Architecture impact

- **ADR required:** No — same decision surface as IR-208 (ADR-0004 flow); no data-model or boundary change.
- **Relevant ADRs:** ADR-0004 (store stays modelctl-owned)

## Validation evidence

- Configuration validation: `.agentic/bin/validate` pass; `.agentic/bin/docs-check --base origin/main --strict` pass (exit codes captured correctly after the IR-208 gate lesson)
- Tests: `packages/core/test/core.test.ts` kind pin (13/13); `apps/server/test/job-events.test.ts` — succeeded-batch pruning (per-name placement drop, cache-row prune only when no node holds the name) and failed-batch re-read with placements kept (16/16 with the disposable PG, server 47/47 overall)
- Build/typecheck: `pnpm -r build` exit 0, `pnpm -r typecheck` exit 0, full `pnpm -r test` exit 0 with the db
- Note: server tests resolve `@irori/core` from its built dist — rebuild core before running server suites after a JOB_KINDS change (initial red herring: ZodError invalid_value)

## Review

- Correctness: the succeeded-batch guard needed an explicit admission (`row.kind === "nas-delete-batch"` bypasses the single-`name` requirement); per-name prune mirrors the IRI-018 convention (placement delete + model_meta delete only when no node holds the name); failed batches keep placements and still fire catalog-request via CATALOG_MUTATING membership; INVENTORY_MUTATING inherits via the existing spread
- Security: only the kind allowlist widened; params persist verbatim as for every kind (the agent validates names before exec — IR-208)
- Compatibility: old agent + new hub → job fails with "unknown job kind" from buildCommand's default (clean job-level failure, no crash); new agent + old hub unreachable (hub gate first)
- Residual risks: stale placement rows survive a FAILED partial batch until the next success or catalog frame — identical to the single-delete failure convention
