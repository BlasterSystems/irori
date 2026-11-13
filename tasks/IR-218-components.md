# IR-218 — Components under v1.1: buttons, chips, fields, overlays, confirm idioms

- **Status:** Done (2026-11-13)
- **Type:** Feature (component layer)
- **Jira:** [IR-218](https://blastersystems.atlassian.net/browse/IR-218) (sprint 1004, epic IR-214)

## Change

- Action primitives in `apps/web/src/assets/irori.css` (v1.1 values from the
  verified mockup): `.bs-link` / `.bs-link--thread` (quiet + destructive text
  actions — thread is never a fill), `.bs-filter` (pressed chips = ink ring,
  never a fill), `.bs-figure`. `.btn` keeps the Irori name with v1.1 values
  (ink 44px / sm 36px, vocabulary decision).
- BenchmarksView migration map applied: the three filter-chip rows that used
  `btn--primary` as the PRESSED state are now `.bs-filter` with
  `:aria-pressed` (decode concurrency, prefill sizes, quality categories).
  BenchmarksView carries exactly one filled button (Start run).
- Chips/glyphs optical sizes, underline `.bs-field`, v1.1 table/log/overlay
  surfaces landed with IR-216 (shared stylesheet).
- Drawer focus contract: the shared `v-dialog` directive already implements
  the APG pattern (focus in, trap, Escape-topmost, restore) and is covered
  by `dialog-ir84.test.ts`; the ServeView drawer pins aria-modal +
  v-dialog. CleanupDrawer/UsageView drawer wiring lands with their screens
  (IR-223).
- Confirm idioms (typed node-name confirm, armed delete, inline cancel with
  blast-radius copy) keep their two-step interaction patterns; their skins
  restyle with the screens that own them (220/221/222/223).

## Acceptance

- [x] components-v11-ir218.test.ts: pressed-chip migration, one-filled-per-surface pilot, action set pins, no elevation box-shadow rule enforced.
- [x] Full web suite green (505 tests).
