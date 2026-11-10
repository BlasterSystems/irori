# Task: Staging/quarantine audit with armed prune (S4 of epic IR-207)

## Objective

Make the hidden `.staging` debris — including `.active-quarantine` and `.cleanup-quarantine` trees left by the 2026-11-09 repair (~932 GB) — visible on the node cleanup panel, and provide an explicit armed prune for the quarantine trees that modelctl can validate.

## Product manager summary

- **One-liner:** See and prune the store's hidden staging/quarantine debris from the cleanup panel.
- **User value:** The 932 GB pile stops being invisible; one armed action reclaims it.
- **Business impact:** Directly frees pool-2 space; prevents the next disk-pressure incident from hiding in dot-dirs.
- **Success metric:** The audit reports the current pile with per-tree bytes; the armed prune removes listed `.active-quarantine` trees and the freed bytes show via the statfs delta.
- **Dependencies & constraints:** ADR-0004 — all mutation via modelctl. `staging-audit` cannot see dot-dirs (`_object_directories` skips them) and `cleanup-staging` refuses non-audited paths, so a new read-only audit runner is required; the prune routes through modelctl `cleanup-quarantine NAME --apply` (validates the repaired reference + metadata before deleting). `.cleanup-quarantine` has NO modelctl command (upstream gap) — report-only in this slice.

## Acceptance criteria

- [ ] `staging-tree-audit` runner kind: read-only walk of `<nasRoot>/.staging` including dot-dirs, per-tree bytes + mtime + classification (staging owner dirs, active-quarantine per NAME/stamp, cleanup-quarantine per id), bounded by a walk deadline (partial report + `timedOut` flag), statfs free-space included (bounded, null on failure)
- [ ] `quarantine-prune` runner kind: params `{names: string[], confirm?: "prune"}` — without `confirm` it is a dry run; armed, it runs `modelctl cleanup-quarantine NAME --apply` per name after the dry validation; per-name result lines + final summary with the statfs freed-bytes delta; invalid names and post-abort names are `skipped`; a failed name never stops the batch
- [ ] Core: both kinds in `JOB_KINDS` (dispatch allowlist); no hub settle changes (quarantine is not catalog/inventory content)
- [ ] CleanupDrawer: "Staging trees" section — audit button, per-name rows with bytes, typed-name arm per the SPEC §11.6 destructive gate, prune results with freed bytes
- [ ] Tests: agent classification/prune-guard suites with a temp store + fake modelctl; web report parser helpers

## Scope

### Included

- `apps/agent/src/staging-trees.ts` + dispatch + `RUNNER_KINDS`; `packages/core/src/jobs.ts` kinds; `apps/web/src/components/CleanupDrawer.vue` + parser helpers in `apps/web/src/models.ts`

### Excluded

- `.cleanup-quarantine` pruning — no modelctl command exists (upstream modelctl follow-up; the audit reports it)
- Free-space download floor — IR-213

## Plan

- [x] Understand requirements and inspect relevant code (modelctl audit_staging/_object_directories/_safe_selected_path/cleanup_staging/cleanup_quarantine, agent hygiene.ts staging flow, CleanupDrawer runJob pattern)
- [x] Confirm architecture impact — none; read-only audit + modelctl-routed mutation per ADR-0004
- [ ] Implement the smallest complete change
- [ ] Add or update tests
- [x] Update documentation — API.md job-kind bullets ride this PR
- [ ] Run validation

## Architecture impact

- **ADR required:** No — the prune mutates only through modelctl; the audit is read-only. ADR-0004 unchanged.
- **Relevant ADRs:** ADR-0004 (store stays modelctl-owned)

## Validation evidence

- Gates: `pnpm -r build` 0 · `pnpm -r typecheck` 0 · db-gated `pnpm -r test` 0 (agent 23 files incl. the new suite, server 47/47 with the db, web 58, core 12, db 3, proxy 4) · `.agentic/bin/validate` 0 · `docs-check --base origin/main --strict` 0
- Tests: `apps/agent/test/staging-trees.test.ts` — classification of a seeded store (rows, bytes, totals, freeBytes), no-root failure, dry vs armed prune with a fake modelctl, failed-name continues, skip-after-abort, invalid/missing params
- Web: boundary parsers via the new core schemas; CleanupDrawer suite + nas-delete suite green

## Review

- Correctness: the audit walks `.staging` one level deep into `.active-quarantine/<NAME>/<stamp>` and `.cleanup-quarantine/<id>` (exactly the shapes modelctl creates) and reports regular owner dirs as one `staging` row; a shared walk deadline bounds the healthy case with partial results + `timedOut`; statfs is deadline-bounded (null on failure) per the IR-136 lesson; the prune dry-runs `cleanup-quarantine NAME --json` first (validation happens there) and only then `--apply`; `freedBytes` is the statfs delta and is null unless armed with a measurable store; the prune never deletes anything itself — it only invokes modelctl with a validated name
- Security: no path-based deletion anywhere; names validated by the store-name rule before any exec; the web arm is a typed-name gate (SPEC §11.6) per model
- Compatibility: `cleanup-quarantine` needs a recent modelctl on the store node — an old binary fails the job with its own error line; the audit works on any modelctl (pure fs walk); both kinds fail cleanly on old agents ("unknown job kind")
- Residual risks: `.cleanup-quarantine` debris is report-only until modelctl grows a prune command (upstream follow-up to file); a wedged NAS mount can hang a readdir (same exposure as the existing hygiene audit; systemic fix is IR-136)
