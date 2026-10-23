# Task: Models — download progress surfaces + density pass (IR-74)

## Objective

Make download progress readable on the Models page: per-entry %/bytes/rate in the
download queue with a batch totals strip, a collapsed one-line-per-entry job log,
repo under the model name, a single `⋯` actions menu per row on both lists,
confirmation for destructive CTAs, and error text in a tooltip instead of an
inline wall. Approved mockup: `mockups/models-downloads.html`.

## Acceptance criteria

- [ ] Queue Model cell stacks name (line 1) over source repo (faint mono, line 2); the dlbar row sits under the subtext; the Status cell keeps only the chip.
- [ ] Batch totals strip above the queue table: combined rate (sum of running speeds), overall bytes done/total + %, ETA from remaining/combined; hidden when no data.
- [ ] One `⋯` menu per queue row, items state-dependent (running: Job output, Cancel job…; waiting: Remove…; downloaded: Job output, Remove…; failed: Job output, Retry, Retry with force…, Remove…); catalog rows get `⋯` with Details… / Delete from NAS….
- [ ] Failed/canceled error renders in a hover/click tooltip on the status chip (width-capped); no inline error wall.
- [ ] Shared confirm modal arms Remove, Retry with force, Cancel job, and Delete from NAS (drawer button included), interpolating the model name and stating semantics.
- [ ] Job drawer for `download-queue` jobs shows a per-entry summary block + total line above the raw output; raw output moves into an expandable details block.
- [ ] Runtime column removed from the catalog; row click still opens the detail drawer.
- [ ] Pure helpers unit-tested (totals, per-state items, summary/ETA formats); all suites + build + validate + docs-check green.

## Scope

### Included

- `apps/web/src/models.ts`: pure helpers — `downloadBatchTotals`, `downloadRowActions`, `downloadJobSummary`, ETA/speed-bucket helpers.
- `apps/web/src/components/ModelsView.vue`: queue + catalog markup/behavior, row menu, confirm modal, error tooltip, job-drawer summary block, queue poll while a download-queue job drawer is open.
- `apps/web/test/`: helper tests (new `download-density.test.ts`), updates to existing suites if markup contracts change.

### Excluded

- modelctl progress emission (upstream JSONL) and the IRORI MODELCTL PIN bump — separate ticket; IR 71 progress fields stay null until then and every dependent surface degrades hidden.
- Server/API changes, migrations, new endpoints.
- Serve-from-catalog (no such handler exists today; row menu carries Details + Delete only).

## Plan

- [x] Approved mockup `mockups/models-downloads.html` (this session, owner-iterated)
- [ ] Implement helpers + view changes
- [ ] Add/update tests
- [ ] Run validation (pnpm test/build, .agentic/bin/validate under python3.12, docs-check)
- [ ] Open PR, adversarial review, merge per standing policy

## Architecture impact

- **ADR required:** No — web-local UI behavior over the existing IR 71 DTO; no data, deployment, or integration boundary changes.
- **Relevant ADRs:** ADR 0009 (downloads/queue field extensions) — unaffected.
- **Proposed ADR:** None

## Validation evidence

- Configuration validation: —
- Tests: —
- Build: —
- Documentation check: —

## Review

- Correctness: —
- Security: — (no new privileged surfaces; confirm modal adds a guard, not a bypass)
- Compatibility: —
- Residual risks: —
