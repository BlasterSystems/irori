# Task: UI feedback round 7 — mobile shell + fleet clock placement (IRI-130)

## Objective

Close the owner's 2026-11-06 UI feedback (re-confirmed with 2026-11-07 captures): (1) horizontal scrolling, (2) mobile top/bottom nav (buttons, footer height), (3) the fleet clock section is over-prominent and needs a UI/UX-expert-defined location. Web-only round; no DB or API changes. Epic **IR-194**; brief: `docs/research/IRI-130-ui-feedback-round-7-research-brief.md` (authoritative for all file:line evidence).

## Product manager summary

- **One-liner:** Fix mobile page overflow, polish the phone topbar/footer, and relocate the fleet clock caps section per an owner-approved mockup option.
- **User value:** The Overview and wide tables are usable on a phone; maintenance controls stop pushing primary content below the fold.
- **Business impact:** Owner-reported defects on the primary surface; low-risk web-only deploy.
- **Success metric:** `documentElement.scrollWidth ≤ innerWidth` on all 11 routes at 320/390/480/720 (light+dark); footer ≤ 2 rows at 390/320; clock section in the approved location, mount-tested.
- **Dependencies & constraints:** Owner pick from the S0 options mockup gates IR-197/IR-198; IR-196 is independent.

## Stories (Jira, sprint 998)

| Story | Scope |
|---|---|
| IR-195 (this task's current story) | S0 options mockup: `mockups/IRI-130-mobile-shell-clock-options.html` — S0 baseline, S1 tap floors, S2–S4 footer variants, S5 band decision, S6 hide rule, S7–S9 clock A/B/C; designer+PM static review; owner picks |
| IR-196 | S1 overflow sweep (`.tbl` definition/wrapper in AnalyticsView, ModelsView containment, stat/320px guards, dead `.stage` rule, Overview culprit from the captures) |
| IR-197 | S2 topbar 44px floors + footer per approved option |
| IR-198 | S3 clock relocation per approved option (hide when empty, touch-legible outcomes, first mount test) |

## Acceptance criteria (IR-195 / S0)

- [x] Options page in `mockups/` (IRI-043/048 idiom), light/dark
- [x] Width sweep 320→1568 clean (`scrollWidth ≤ innerWidth`), zero console errors
- [x] Clock placement scenes A/B/C + empty-fleet rule + band decision present
- [x] Designer + PM static review round applied (findings list in mockups/PLAN.md)
- [x] Recorded in `mockups/PLAN.md`; option page NOT added to the curated index
- [x] Owner picks an option in conversation (gates IR-197/IR-198) — **picked 2026-11-07: footer B1, band keep, clock A (demote)**

## Scope

### Included
- The options mockup page + its page-scoped CSS/scripts; mockups/PLAN.md record.

### Excluded
- Any `apps/` change (S1–S3 stories); the curated `mockups/index.html` (option pages are never listed there).

## Plan

- [x] Research brief with file:line evidence (IRI-130)
- [x] Build the options page
- [ ] Browser verification (light/dark, sweep, interactions, console)
- [ ] Expert review round, apply findings
- [ ] PLAN.md record; owner pick gates IR-197/IR-198

## Architecture impact

- **ADR required:** No (presentation-only round; no schema/API/deployment changes).

## Validation evidence

- Configuration validation: n/a for S0 (static mockup; no repo config touched). App-side validation lands with IR-196..198.
- Tests: no app tests touched. Mockup verification (2026-11-07, headless Chromium against `python3 -m http.server` on mockups/): `documentElement.scrollWidth` sweep CLEAN at 320/390/480/720/721/900/1024/1568 in light AND dark; 0 console errors; interactions green (S8 sheet open/close/scrim-click, S9 fold aria-expanded toggle, theme toggle); footer heights measured — baseline 89 px (3 rows, 28 px CTAs), B1 60 px one row (44 px CTAs, watts hidden <390), B2 84 px two rows; Apply/Clear grouped right on their own row; screenshots at /tmp/iri130-{light,dark,s0,s2,s3,s8-open,s8-dark}.png (transient).
- Build: n/a — no app code changed (hard boundary: mockup + Jira only).
- Documentation check: mockups/PLAN.md round record written; option page intentionally NOT added to the curated mockups/index.html.

## Review

- Correctness: two static review rounds (senior designer + senior PM) on 2026-11-07; 2 P1 + 8 P2 + 4 P3 findings, all applied (full list in mockups/PLAN.md). Key catches: the 320px endorsement claim never fired; the recommended option's controls lacked the 44px floor the round preaches; option A misstated its own control set; the drawer lacked the fleet status line (200/207/502); persistence checkbox was depicted pre-checked (app default is unchecked); clock scenes depicted a fourth footer that is none of the options.
- Security: n/a — static mockup, no privileged surfaces
- Compatibility: sweep clean 320→1568 light+dark after fixes; 0 console errors; interactions asserted (sheet, scrim, fold, theme, focus).
- Residual risks: the owner pick may change S2/S3 scope (footer B2/B3 or clock A/C are fully specified alternatives); the S1 sweep (IR-196) may surface overflow culprits beyond the ones inventoried; commit pending owner request (implement skill rule).
