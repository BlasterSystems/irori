# Task: Center the main content column on ultra-wide screens (IR-261 / IRI-147)

## Objective

On viewports wider than ~1692 px the main content column (1360 px cap) sits
flush after the sidebar with a large empty right area. DS v1.1 was left-aligned
by design; the owner decided 2026-11-16 to re-center on wide screens.

## Product manager summary

- **One-liner:** the capped content column centers in its grid track on ultra-wide viewports; nothing changes below the cap.
- **User value:** balanced layout on big screens instead of a left-hugging column with a large empty right margin.
- **Success metric:** at ≥1692 px the column has equal left/right margins (64/64 at 1720 px with the expanded sidebar); at 1400 px and below nothing changes.
- **Dependencies & constraints:** DS process — mockup-first; the change is one property mirrored in the v1.4 mockup delta and pinned by the ds-markup contract test.

## Acceptance criteria

- [x] Mockup delta in `mockups/irori-v14.css` carries `.content { margin-inline: auto; }`; browser-verified light + dark at 1720 px (equal 64/64 margins) and 1400 px (no change).
- [x] `apps/web/src/assets/irori.css` `.content` gains `margin-inline: auto`.
- [x] `apps/web/test/ds-markup.test.ts:104` pin updated to the new rule string.
- [x] Gates green; PR merged.

## Scope

### Included

- The one-property centering + mockup delta + pin update.

### Excluded (per ticket)

- Per-view max-width changes; sidebar geometry; mobile shell; column-count changes at ultra-wide.

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** No — one CSS property reversing to the pre-IR-217 centered shell; no data model, boundary, or deployment change. The DS decision is recorded in the mockup delta, the pin test, and IR-261.

## Validation evidence

- Browser (mockup-first): 1720 px light + dark → `.content` left 296 / right 64 (equal margins in the 232 px-sidebar track, width 1360); 1400 px → left 232 / right 0 (fills the track, unchanged). Dark engaged via the real `#themeBtn` toggle (`data-theme="dark"`). Screenshots attached to the session.
- Tests: `IRORI_TEST_DATABASE_URL=…54329 pnpm -r test` — 1430 passed, 0 failed (web 528 incl. the updated `ds-markup` pin); `pnpm -r typecheck` 6× Done; `pnpm -r build` green.
- Documentation check: `.agentic/bin/docs-check` — no gaps.

## Review

- Correctness: `margin-inline: auto` centers a block with a max-width inside a wider grid track; below the cap the track is the constraining width, so auto margins are 0 — a mathematical no-op, verified at 1400 px.
- Security: none.
- Compatibility: global `.content` — all 11 views center identically (no page overrides the cap, so none regresses asymmetrically); the Transfers dock is a fixed overlay and does not interact.
- Residual risks: none known; the sticky topbar keeps spanning the full `.main` width by design (mockup parity).
