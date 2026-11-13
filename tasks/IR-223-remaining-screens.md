# IR-223 — Remaining screens under DS v1.1

- **Status:** Done (2026-11-13)
- **Type:** Feature (screen sweep)
- **Jira:** [IR-223](https://blastersystems.atlassian.net/browse/IR-223) (sprint 1004, epic IR-214)

## Change

- **Destructive-as-thread-link sweep**: every `btn--danger` outside the two
  screen tickets converted to `.bs-link--thread` (CleanupDrawer prune arms,
  NodeDetail confirm/cancel actions, TransfersDock cancel, HubSettingsModal
  Clear token, BenchmarksView Cancel). Grep audit: zero `btn--danger` in
  apps/web/src; zero `'btn--primary':` pressed-state leftovers.
- **Underline forms**: HubSettingsModal (all five sections) and NodeModal
  converted to `.bs-field`; selects keep the bordered hybrid; modal
  surfaces move to rule-2 borders + 4px radius + paper-72% scrim.
- **Chrome surfaces**: TelemetryDrawer + TransfersDock → v1.1 drawer
  (rule-2 border, 4px radius, stat 17/600 heads, token font sizes);
  HealthBanner in the alert idiom (IR-220).
- **Analytics**: the lens + prefill charts use the LensChart `labeled`
  variant (four lenses ride the same component).
- **Radius/font drift**: ChatsView turn surfaces, NodeDetail code blocks →
  `--radius-panel`; dead hex fallbacks in `var()` removed.
- **Overflow fixes from the live sweep** (320→1568 × 10 routes × both
  themes, all clean): `.seg` scrolls instead of pushing; pagehead action
  rows wrap; the mobile topbar lead keeps 44px floors (the action group
  wraps below it); CommunityView release tokens wrap anywhere.
- **Transfers surface shape**: unchanged (blocked on the IRI-048 owner
  decision) — skin only, per the ticket.

## Acceptance

- [x] pnpm build + full monorepo test suite green; grep audits clean (no pressed primaries, no v1.0 token remnants, no elevation box-shadows).
- [x] Overflow sweep green 320→1568 on every route, both themes (browser-verified).
- [x] Zero console errors across all routes in the browser pass.

## Deviations

- ServeView's wizard fields ported with IR-221 (the wizard lives there);
  ModelsView's catalog/toolbar with IR-222 — this ticket covers everything
  else and the cross-cutting sweeps.
