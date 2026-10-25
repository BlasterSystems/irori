# Task: IRI-024 — Overview feedback round 2 (IR-88)

## Objective

Owner feedback on the Overview page (2026-10-25, screenshot of the DEV
workers/telemetry section, build dev-0.3.0-26 — i.e. the pre-batch build):

1. Section renamed **Nodes** (not Workers) and head nodes shown; NAS stays in
   its own section above.
2. CPU/GPU temperatures above 70 °C render orange.
3. Telemetry section spacing looks wrong on the screenshot — verify on the new
   build with measurements.
4. Disk usage above 80 % renders orange.

Jira: IR-88 (Story, epic IR-78, sprint 985, label frontend).

## Acceptance criteria

- [ ] Overview Nodes section lists head + worker sparks, no NAS card.
- [ ] Temps ≥ 70 °C render orange on node cards and node detail (CPU and GPU).
- [ ] Disk usage > 80 % renders orange: card DISK row value, NodeCard/NodeDetail,
      the Overview NAS-store row, and the disk chip (NodeCard + CleanupDrawer).
- [ ] Analytics temps lens warn tier follows the same 70 °C constant (one scale).
- [ ] SPEC.md matches (temps warn tier, disk chip rule).
- [ ] Tests updated and green; Telemetry spacing verified with measured px.

## Scope

### Included

- `apps/web/src/analytics.ts` — `TEMPS_WARN_C` 85 → 70; `DISK_WARN_PCT = 80`;
  `diskChipCls` collapses to warn ≥ 80.
- `apps/web/src/card-data.ts` — `CardRow.warn?` set on the DISK row > 80 %.
- `apps/web/src/components/NodeCard.vue`, `NodeDetail.vue` — apply the hot
  class to the disk row value.
- `apps/web/src/components/OverviewView.vue` — hot class on NAS-store row.
- `apps/web/src/components/CleanupDrawer.vue` — chip warn ≥ 80.
- `apps/web/src/assets/irori.css` — rename `.temp--hot` → `.metric--hot`
  (no behavior change for temps; the color now also marks non-temp values).
- `docs/SPEC.md` — temps warn tier line, disk chip tier line.
- Tests: `analytics.test.ts`, `card-data.test.ts`, `chrome-markup.test.ts`.

### Excluded

- No server/agent changes; no new thresholds on other metrics.
- No commit/push (rides the pending feedback-batch tree per owner).

## Plan

- [x] Inspect current code (card-data, components, css, tests)
- [x] Confirm no ADR (UI-level thresholds; no data/deployment/boundary change)
- [x] Implement the smallest complete change
- [x] Update tests
- [x] Update SPEC.md
- [x] Run validation + browser smoke with measurements

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** None
- **Proposed ADR:** None

## Notes

- `TEMPS_WARN_C` is the analytics temps-lens warn tier too
  (AnalyticsView.vue:72,103,217); changing it moves the lens tier/copy —
  intended (owner rule is one temp scale), SPEC.md updated.
- The screenshot's 0 px Telemetry gap and full-bleed content are the pre-batch
  build; the working tree already has `.page` longhand padding (irori.css:76-84)
  and `margin-top: 20px` on the feed card. Item 3 is measure-and-confirm only.
- Disk chip previously: plain 80–89, warn ≥ 90, none < 80 (SPEC §11.6). Owner
  rule collapses it to warn ≥ 80.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — "Configuration validation passed"
- Tests: `pnpm test` exit 0 (all packages); web suite 212/212 including the
  updated `analytics.test.ts` (warn ≥ 80 chip), `card-data.test.ts` (70 °C
  boundary + disk-row warn fixture), `chrome-markup.test.ts` (`metric--hot`
  pins on both templates + css rule)
- Build: `pnpm build` — vue-tsc + vite green, dist emitted
- Documentation check: `.agentic/bin/docs-check` — "No heuristic documentation gaps detected"
- Browser smoke (vite + fetch/EventSource fixtures, validated offline against
  `packages/core/dist` sseEventSchema/nodeInfoSchema; 0 console errors):
  - `h2` "Nodes" lists DGX-1 (head), DGX-2, DGX-3; NAS absent from the grid,
    present only as the "NAS store" hero card.
  - Temps: DGX-1 GPU 71 °C and DGX-3 GPU 70 °C render `.metric--hot`
    (rgb(190, 56, 39) light / rgb(250, 140, 106) dark); DGX-2 66 °C neutral.
  - Disk: DGX-3 DISK value + NAS-store value carry `.metric--hot` at 83 %/81 %;
    "Disk 83%" chip--warn only on DGX-3; DGX-1/DGX-2 (≈39 %) neutral.
  - Spacing: nodes grid → Telemetry card gap measured 20 px; `main.container.page`
    padding 24 px horizontal, width 1200 px (no full-bleed).
  - Screenshots light + dark at 1568 px verified.

## Review

- Correctness: thresholds single-sourced (TEMPS_WARN_C, DISK_WARN_PCT); card
  rows carry the warn flag so cards and node detail share one code path.
- Security: no privileged surfaces touched (web UI constants/classes only).
- Compatibility: `.temp--hot` rename is internal to the web bundle.
- Residual risks: the Analytics temps lens warn tier/copy moves to 70 °C with
  the constant (intended, one scale app-wide; SPEC §9 updated). The disk chip
  is now always warn when visible — the plain 80–89 tier is gone by design.
