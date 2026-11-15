# IR-249 — Collapsed rail: Add node button keeps menu-tier width — cap to the 36px control square

- **Status:** Done (2026-11-15; deployed `dev-0.7.0-22`, verified live on the hub — Jira closed with evidence comment 26079)
- **Type:** Bug fix (CSS geometry, round-13 owner feedback)
- **Jira:** [IR-249](https://blastersystems.atlassian.net/browse/IR-249) (sprint 1004, epic IR-237)
- **Research:** [tasks/research-collapsed-rail-add-node-button.md](research-collapsed-rail-add-node-button.md) (evidence + measurements)

## Objective

In the collapsed rail (≥901) the Add node button must render as the same bordered
36×36 control square as the range trigger, centered on the shared 34px axis —
instead of the stretch-filled 51×36 menu-tier box it has today.

## Product manager summary

- **One-liner:** Cap the collapsed-rail Add node button to the 36px control square and center it.
- **User value:** The rail's two tools read as a matched pair; no oversized/left-shifted control.
- **Business impact:** None (cosmetic polish).
- **Success metric:** Measured box 36×36 at x≈16 at 1568 collapsed, matching the range trigger.
- **Dependencies & constraints:** None (pure CSS, media-scoped).

## Acceptance criteria

- [x] Collapsed rail ≥901: Add node renders 36×36 centered on the axis (box x=15.5, w=36, h=36), matching the range trigger's box.
- [x] ≤900 hamburger menu and expanded sidebar unchanged (Add node keeps label + full-width menu styling).
- [x] Mockup mirror updated and re-measured: + box 36×36 centered.
- [x] `apps/web/test/ds-markup.test.ts` pins the new rule; workspace tests green.
- [x] Deployed verification: `dev-0.7.0-22` → CD run 43706927160 green; hub re-measured — Add node 36×36 at x=15.5 (cx 33.5), box-identical to the range trigger.

## Scope

### Included

- `apps/web/src/assets/irori.css` — replace the collapsed `.btn` rule inside the ≥901 block.
- `mockups/irori-v14.css` — same cap for `.bs-btn` (owner overrode the approved mockup geometry).
- `apps/web/test/ds-markup.test.ts` — verbatim-rule pin.

### Excluded

- Any behavior change (button still opens NodeModal from any route).
- The ≤900 hamburger menu and expanded sidebar.
- Icon set, button semantics, a11y attributes (unchanged).

## Plan

- [x] Understand requirements and inspect relevant code (research doc has the full chain)
- [x] Confirm architecture impact — none; CSS-only local fix
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation (none needed — geometry, not behavior; docs-check confirmed no gaps)
- [x] Run validation + live smoke

## Architecture impact

- **ADR required:** No (local implementation detail, no durable/cross-cutting decision)
- **Relevant ADRs:** None
- **Proposed ADR:** None

## Validation evidence

- Configuration validation: passed (`.agentic/bin/validate`)
- Tests: web suite green — 60 files / 517 tests, incl. the new verbatim pin (`ds-markup.test.ts:120-122`)
- Build: clean (`pnpm build`, all packages)
- Documentation check: passed (3 changed files, no heuristic gaps; docs describe behavior, not geometry)
- Browser smoke (1568×961, collapsed, vite dev + hub tunnel):
  - App: Add node box **36×36 at x=15.5, cx 33.5** — identical to the range trigger (36×36 at x=15.5); glyph 18px on the shared axis; `.tools-cta-label` display:none.
  - Mockup (`v14-round8.html`): identical — 36×36 at x=15.5, cx 33.5, clock 36×36 at x=15.5.
  - Screenshot: the two bordered squares read as a matched pair (was 51×36 stretched before).
  - Note: the app flashed "OFFLINE · 0 nodes" on first paint; REST through the tunnel verified fine (`/api/v1/version` + 4 nodes) — transient load race on the throwaway relay, not this change's surface.
- Deployed (`dev-0.7.0-22`, CD run 43706927160 green): healthz ok, version tag matches, served stylesheet carries the media-scoped new rule, and the hub re-measures Add node 36×36 at x=15.5 (cx 33.5) — box-identical to the range trigger.

## Review

- Correctness: measured box parity with the range trigger on both surfaces; rule media-scoped to ≥901 + collapsed, verified in-browser.
- Security: CSS-only; no new surfaces, endpoints, or privileges.
- Compatibility: ≤900 hamburger (`App.vue:321-327`) and expanded sidebar untouched; mockup parity restored (owner had overridden the approved geometry).
- Residual risks: none open — deployed and verified (`dev-0.7.0-22`). Note: the + button relies on `--control-sm` (36px) staying in sync with `.iconbtn` — both read the same token, so they move together.
