# IR-222 — Models screen under DS v1.1 (catalog, drawer with armed delete, download modal)

- **Status:** Done (2026-11-13)
- **Type:** Feature (screen skin)
- **Jira:** [IR-222](https://blastersystems.atlassian.net/browse/IR-222) (sprint 1004, epic IR-214)

## Change (ModelsView.vue only, +719/−216)

- **Store strip**: barrow from the NAS node's live snapshot
  (`computeNasData` + `metric--hot` at `thresholds.diskWarnPct`), catalog
  objects/page counts from the same fetch as the page (no hardcoded
  totals — nav counts and the strip agree), store-health popover on a
  paper-2 surface with the store-wide hygiene verbs.
- **Jobs rows**: active transfer jobs from `live.jobs` (SSE + re-seed) as
  the mockup row grid — glyph, name/target, bar, rate, running chip,
  Output link, thread-ink Cancel (shared guarded confirm).
- **Catalog**: bordered-hybrid search, aria-pressed runtime chips,
  sort select (localStorage kept), hairline v1.1 table, aria-current
  pagination at the hub's 25/page, IR-210 bulk-select delete intact.
- **Detail drawer**: head + runtime chip + close, kv facts, placement rows
  with blockers, capacity reason + clean-up-disk (shared CleanupDrawer),
  **armed delete per SPEC §6**: dispatches the dry-run `nas-delete` plan,
  the job sheet offers the typed arm (`nas-delete-apply`) once the plan
  settles; the immediate-apply path is gone.
- **Download modal/queue/expand-quants**: v1.1 surfaces, preflight banner,
  force-dark logs, tier overrides ≤900.
- One `.btn--primary` per surface (page chrome; download modal); every
  destructive action is `.bs-link--thread`; no box-shadow, no hex.

## Deviations (data, not skin — no hub surface exists)

- Drawer kv shows repo/size/added: object path, rev, companions and
  serve-command copy are not fetchable from the hub (would need server
  work outside this epic). Placement chips stay in the drawer (per-model
  placement isn't fetchable page-wide); the catalog gained a Runtime
  column instead.
- Modal primary label keeps the pinned "Add N to queue" (chrome-markup)
  rather than the ticket's "Queue download".

## Acceptance

- [x] models-wrappers-ir84, models-order, download-density, download-progress green; full suite 509; typecheck/build green.
- [x] Armed delete and download modal styled and reachable; aria-pressed chips; aria-current pagination.
