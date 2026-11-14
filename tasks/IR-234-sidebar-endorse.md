# Task: Sidebar header — endorse line collides with the collapse chevron (shorten to BLASTERSYSTEMS)

Jira: IR-234 (story of epic IR-233, round 9). Research: `tasks/research-ds-v14-ui-feedback-round-9.md`.

## Objective

The sidebar's collapse chevron must clear the brand lockup. Owner decision (gate 2026-11-14): keep the chevron exactly where it is and shorten the endorse text from "A BlasterSystems product" to "BLASTERSYSTEMS".

## Product manager summary

- **One-liner:** Endorse line becomes "BLASTERSYSTEMS" so the collapse button no longer overlaps it.
- **User value:** The sidebar header stops reading as a broken menu icon plus a stray arrow.
- **Business impact:** Visual quality of the primary chrome on every page.
- **Success metric:** Endorse right edge ≥ 8 px left of the button hit area at 1280–1920; measured −24.4 px overlap today.
- **Dependencies & constraints:** None; web-only. DS deviation recorded in SPEC (owner's call — he owns the DS).

## Acceptance criteria

- [ ] Endorse text "BLASTERSYSTEMS" in the app sidebar and the round-8 mockup; no overlap at 1280/1568/1920
- [ ] Collapsed rail unchanged (centered rotated chevron, 68px); ≤900 hamburger tier unchanged
- [ ] Markup test pins the new text and rejects the old; SPEC.md brand line matches

## Scope

### Included

- `apps/web/src/App.vue` endorse span; `mockups/v14-round8.html`; `docs/SPEC.md` brand line; `apps/web/test/ds-markup.test.ts` pin

### Excluded

- Historical mockups (v11-*, IRI-043/048/130, page mocks) — decision artifacts of past rounds
- ADR-0005 (accepted, historical)

## Plan

- [x] Inspect App.vue:231-238, iroiri.css:132-142/178-180, measured overlap on live hub + mockup
- [x] Architecture impact: none (cosmetic text; no ADR)
- [x] Implement the text change (chevron untouched)
- [x] Update tests
- [x] Update SPEC.md
- [x] Validate + browser-verify

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** ADR-0005 (brand lockup spec — historical record, not modified)

## Validation evidence

- Configuration validation: passed (`.agentic/bin/validate`)
- Tests: workspace green — web 514, server 237 (+171 db-gated skipped), agent 309, core 111, proxy 24, db 8; ds-markup pins the new text and rejects the old
- Build: clean (`pnpm build`)
- Documentation check: passed (`.agentic/bin/docs-check`, no heuristic gaps)
- Browser: endorse "BLASTERSYSTEMS", collapse-button gap +41.6px at 1280 and 1568 (was −24.4px); collapsed rail unchanged (68px, centered rotated chevron); ≤900 hamburger tier unchanged; overflow 0 at 390/1280/1568

## Review

- Correctness: text-only change; the uppercase render comes from the existing `text-transform: uppercase` (iroiri.css:140)
- Security: n/a
- Compatibility: collapsed rail + ≤900 tiers untouched (button position unchanged)
- Residual risks: none known
