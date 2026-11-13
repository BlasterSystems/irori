# IR-221 — Serve screen under DS v1.1 (staged transfers, drawer, wizard entry)

- **Status:** Done (2026-11-13)
- **Type:** Feature (screen skin)
- **Jira:** [IR-221](https://blastersystems.atlassian.net/browse/IR-221) (sprint 1004, epic IR-214)

## Change

- Setup cards: `setup__name` 17/600 + mono kind meta; member rows in the
  v1.1 row grid (glyph | name | state/rate, hairline rules) fed by the
  unchanged `setupNodeLines` data.
- States: healthy = no state chip (card and drawer); stopped = stage chip
  with halt glyph; foreign = ONE held chip + warn banner carrying the
  existing subline; failed = held banner with remediation copy; starting =
  staged per-stage progress rows (percent/rate/ETA) restyled with a working
  per-stage cancel.
- Destructive → thread-ink text links (Stop/Confirm stop with the armed
  underline kept, Remove/Confirm remove, Cancel transfer); no `btn--danger`
  left. Arm-then-confirm stays two-step.
- Detail drawer: shared drawer chrome, kv facts, forced-dark engine log,
  placement stage rows; footer actions at 44px floors.
- Wizard: all form fields are underline `.bs-field` (invalid boxes get the
  thread underline via scoped `.is-invalid`), head-node select keeps the
  bordered hybrid; sticky head/foot; picks/env grids reuse `.pick`.
- IR-152 focus contract intact (v-dialog + aria-modal + v-scrim-close on
  drawer and wizard); "New setup…" opens the wizard (big-views mount test).
- Dropped scoped duplicates now owned by the shared stylesheet
  (drawer-scrim/drawer/pick, legacy fallbacks).

## Acceptance

- [x] serve.test.ts, serve-shaped-ir84.test.ts, serve-helpers-ir84.test.ts green (updated pin: healthy renders no state chip).
- [x] Full web suite 509 green; web build (vue-tsc) green.
- [x] One .btn--primary per surface; no box-shadow; no hex colors.
