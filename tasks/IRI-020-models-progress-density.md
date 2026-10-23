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
- [x] Implement helpers + view changes
- [x] Add/update tests
- [x] Run validation (pnpm test/build, .agentic/bin/validate under python3.12, docs-check)
- [x] Open PR (#30), adversarial review, merge per standing policy

## Architecture impact

- **ADR required:** No — web-local UI behavior over the existing IR 71 DTO; no data, deployment, or integration boundary changes.
- **Relevant ADRs:** ADR 0009 (downloads/queue field extensions) — unaffected.
- **Proposed ADR:** None

## Validation evidence

- Configuration validation: `.agentic/bin/validate` (python3.12) — "Configuration validation passed", exit 0.
- Tests: `pnpm --filter @irori/web test` — 21 files, 210/210 green, including new `apps/web/test/download-density.test.ts` (9 tests: batch totals math, per-state menu items, summary/ETA formats, speed buckets) and the chrome-markup contract suite.
- Build: `pnpm --filter @irori/web build` — vue-tsc clean, vite bundle 407 kB.
- Documentation check: `.agentic/bin/docs-check --base origin/main --strict` — exit 0, no gaps.
- Live smoke: built dist served locally with mocked hub endpoints, exercised in Chromium — headers Model/Size, stacked repos, batch strip "85% · 1416.5 GiB / 1669.3 GiB · 486 Mb/s combined · eta 1h 14m" (hand-verified math), per-state menus, interpolated confirm dialogs, tooltip hover/click, click-away close, zero console errors. (Pixel capture unavailable this session — browser screenshot tooling hangs environment-wide, incl. about:blank; DOM probes + the approved mockup carry the visual evidence.)

## Review

- Correctness: 2-reviewer adversarial round (VueView, CoreLogic) — 6 findings, all fixed on the branch: batch-cancel blast radius stated (settleBatch settles every entry sharing the job), confirm-modal race (dismiss during run no longer clears a newer dialog or sticks busy), drawer delete + drawer cancel routed through the confirm, cancel-failure surfaced to queueError/jobError, totals numerator excludes bytes with no matching denominator (regression-pinned), dead glyph map removed.
- Security: no new privileged surfaces; the confirm modal adds a guard, not a bypass — the destructive APPLY remains gated behind a succeeded dry-run's drawer (armed-by-design, documented).
- Compatibility: no API/DTO changes; IR-71 progress fields stay nullish and every dependent surface degrades hidden.
- Residual risks: per-entry %/rate values wait on modelctl progress emission (upstream JSONL + IRORI MODELCTL PIN bump, separate ticket); batch totals/count read only what the DTO carries.
