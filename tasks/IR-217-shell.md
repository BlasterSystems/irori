# IR-217 — App shell: sidebar plus topbar with mobile menu under DS v1.1

- **Status:** Done (2026-11-13)
- **Type:** Feature (shell)
- **Jira:** [IR-217](https://blastersystems.atlassian.net/browse/IR-217) (sprint 1004, epic IR-214)

## Change

- `App.vue` rebuilt on the v1.1 app pattern: sticky 232px paper-2 sidebar
  (canonical brand lockup — 30×10 mark, name 17/600, mono endorse; nav
  items 42px with the thread active line; foot with pulse live status,
  version · deploy tag, watts) + sticky topbar (offline warn chip,
  Transfers/Telemetry CTAs with the live count bubble, hub-settings gear
  beside the theme toggle) + hamburger disclosure menu at 900px and below
  carrying the owner-mandated deploy line and connection status
  (IR-197 B1 home preserved via .bs-menu-foot).
- Full router-linked nav inventory: Overview, Models, Serve, Analytics,
  Usage, Chats, Benchmarks, Audit, Logs, Community. "Nodes" is the
  Overview surface and Settings is the topbar gear (IA carry-over — the
  hub has no separate nodes route or settings view; hiding Community
  would be a silent IA drop). Counts are hub-derived totals: nodes from
  the live registry, Models from the catalog page total, Serve from
  fetchSetups — re-fetched on navigation and reconnect so page totals and
  nav counts cannot drift.
- The old viewport-bottom footer is gone (superseded): version/watts live
  in the sidebar foot and the per-page refresh-note; #app flex shell and
  .container/.page/.foot CSS removed. Content column is .content
  (max-width --content-max, v1.1 tiers 600/900/1100).
- data-tier machinery (src/tiers.ts small ≤900 / medium / full) unchanged;
  44px floors on all topbar controls under full tier.
- ds-markup.test.ts and chrome-markup.test.ts rewritten to pin the new
  shell (hub-settings gear pin updated: gear before theme toggle, no
  footer).

## Acceptance

- [x] Navigation 320→1568; hamburger opens/closes with click-outside, Escape (focus returns), route/tier change; deploy line + connection status visible in the menu.
- [x] Sidebar hidden ≤900 with the mobile lockup in the topbar.
- [x] overflow-sweep-ir196 pins intact; full web suite green.
