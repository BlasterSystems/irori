# Task: Download queue — manifest-conflict force, progress + speed, HF token

## Objective

Three download-queue improvements, decided in
`docs/research/IRI-017-research-brief.md`:

1. Resolve modelctl's `manifest already exists with different settings`
   preflight failure with a per-entry opt-in `force` (agent already emits it;
   core/DB/dispatch strip it today).
2. Show real per-entry download progress and speed in the queue UI (bytes,
   not file-count `it/s`), with a smooth transition animation on change.
3. Support HF-token downloads without putting the token in job params —
   agent-unit env var, documented.

## Acceptance criteria

- [x] `force` accepted by `downloadCreateSchema`/batch schema
      (`packages/core/src/downloads.ts`), stored on `download_queue`
      (migration 0016), passed by dispatch
      (`apps/server/src/download-queue-service.ts`), and settable per entry
      in the download modal; a failed entry offers "Retry with force".
- [x] Agent `hf`/tqdm progress lines are throttled like the rsync ones
      (`apps/agent/src/modelctl.ts` throttle regex now covers `it/s` and
      `s/it` bars).
- [x] Structured progress path in place: hub parses `progress:` JSONL frames on
      `download-queue` jobs (`parseProgressLine` + `onJobOutput`) into new
      `download_queue` columns (`bytes_done`, `bytes_total`, `speed_bps`);
      no-op until the pinned modelctl emits them.
- [x] Queue rows render a progress bar + speed chip for running entries with a
      CSS width/color transition (reduced-motion respected); speed shown in
      bits (`Mb/s`, owner request).
- [x] `IRORI_HF_TOKEN` documented for the agent unit (CONFIGURATION.md /
      DEPLOYMENT.md); no token in job params, DB, or output frames.
- [x] Tests: core schema round-trip, dispatch mapping with force, hub progress
      parser + row mapping, agent config parse; all suites + typecheck green.

## Scope

### Included

- Core schema + `packages/db` migration 0016 + server dispatch/DTO plumbing.
- Web: download modal force control, failed-row retry-with-force, queue-row
  progress bar + speed chip, animation.
- Agent: progress-line throttle (and `extraEnv` passthrough only if needed).
- Docs: CONFIGURATION.md / DEPLOYMENT.md env tables; brief link below.

### Excluded

- Hub-side manifest regeneration/conflict preview (deferred, brief §1.4 C).
- Hub-side token for gated-repo quants listing (brief §3.3 note).
- modelctl upstream `--progress-json` implementation (piresbruno/modelctl —
  separate upstream change; the hub parser ships first and no-ops until the
  pinned modelctl emits events; `IRORI_MODELCTL_PIN` bump rides its own PR).

## Plan

- [x] Research: `docs/research/IRI-017-research-brief.md` (decision-complete)
- [x] Migration 0016 + core schema + dispatch mapping for `force`
- [x] Download modal: per-entry force checkbox + failed-row "Retry with force"
- [x] Agent: extend the existing 1/s throttle to hf `it/s` bars
- [x] Hub: parse `progress:` JSONL on download-queue job frames → row columns
- [x] Web: progress bar + speed chip with transition animation
- [x] Docs: HF_TOKEN env documentation
- [x] Tests + validation

## Architecture impact

- **ADR required:** No — ADR-0004 already governs the modelctl store
  relationship; the migration is additive. If `.agentic/bin/docs-check` flags
  the migration path, add a dated note under ADR-0009 (IR-70 precedent).
- **Relevant ADRs:** ADR-0002 (Postgres), ADR-0004 (modelctl store engine),
  ADR-0007 (agent updates/pins).
- **Proposed ADR:** None.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` → exit 0 ("Configuration
  validation passed").
- Tests: `pnpm -r test` green with `IRORI_TEST_DATABASE_URL` at a disposable
  Postgres — server 164/164 (db-gated, incl. the new force/progress
  integration tests), core 69/69, web 191/191 plus the new
  `download-progress`/`nas-delete` helper tests, agent/db/proxy green.
  `pnpm -r typecheck` exit 0 (after rebuilding @irori/core — stale-dist
  gotcha). Migration 0016 SQL reviewed: four additive columns, no drift.
- Build: `pnpm -r build` exit 0.
- Documentation check: `.agentic/bin/docs-check` → exit 0, 17 changed files,
  no gaps (ADR-0009 dated addendum covers the migration).
- Live smoke (disposable PG + built stack on :3948): migration columns present
  on boot; `POST /downloads {force:true}` → DTO `force: true`; batch with
  mixed force persists per entry; `POST /downloads/:id/retry {force:true}` →
  200 with `force: true`; invalid transition → 409. Browser (built bundle):
  download modal shows the per-row Force column + tooltip and a working
  checkbox; a running row with bytes renders `25% · 1.0 GiB / 4.0 GiB` and a
  `500 Mb/s` chip with the `--ok` bucket fill.

## Review

- Correctness: dispatch maps `force` only when true (no batch-wide default);
  progress rows matched by name then entry index (dispatch order =
  pending rows by createdAt) with a single-entry fallback; terminal settles
  null the stale speed but keep the last byte counts; dispatch resets all
  three columns.
- Security: `IRORI_HF_TOKEN` is read by the agent, handed to the modelctl
  child as `HF_TOKEN` only — it never enters job params (core contract,
  `packages/core/src/jobs.ts`), the DB, API responses, or output frames; the
  hub never sees it.
- Compatibility: new DTO fields are nullish (old hubs parseable, IRI-016
  precedent); progress columns null until modelctl emits events (UI falls
  back to status-only rows); the agent throttle is a superset of the old
  rsync-only regex.
- Residual risks: modelctl upstream must emit `progress:` JSONL for live
  byte/speed data (hub parser + columns ship first, UI degrades gracefully);
  "Retry with force" replaces a deliberately-different manifest — owner
  opt-in per entry, modelctl's guard remains the default outcome.
