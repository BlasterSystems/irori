# Task: Horizontal overflow sweep fix across all 11 routes (IR-196 / S1)

Jira: IR-196 (story of epic IR-194, IRI-130 round 7). Brief: `docs/research/IRI-130-ui-feedback-round-7-research-brief.md` §5.3.

## Acceptance criteria (from IR-196)

- `documentElement.scrollWidth` never exceeds `innerWidth` on any of the 11 routes at 320/390/480/720 px, light and dark
- AnalyticsView tables contained (3 × `.tbl` — a class with no CSS definition — replaced with the app's flush-wrapper idiom)
- ModelsView tables contained (main, queue, node-state, bulk-add)
- The Overview culprit from the owner screenshot (~367 px, page scrolled sideways, brand/node names/row labels clipped) identified by live tree-bisect and fixed
- `.stat__value` gets an ellipsis/min-width guard
- NodeDetail:1385 path ellipsis `max-width: 320px` → `min(320px, 100%)`
- Inert `body .stage` rule fixed or deleted
- No nested scrollbars where wrapping suffices
- Regression markup/mount tests for every touched component (IR-175 gate holds)

## Plan

1. Survey (done): defects per brief §5.3 confirmed against source — AnalyticsView 3 × `class="tbl"` in padded `card__body` (no wrapper, no CSS); ModelsView tables unwrapped; `.stat__value` nowrap without ellipsis (iroiri.css:203) inside grid items with default `min-width: auto`; NodeDetail inline `max-width: 320px`; `body .stage` grid-template rule with no `display: grid` anywhere (ServeView uses `.stage` rows of label+bar+val but never defines the class); UsageView error-signature `max-width: 420px` exceeds a 375 px viewport.
2. Reproduce first: live vite+forwarder against DEV hub (irori-web-browser-verify option A), 11 routes × {320, 390, 480, 720} × light/dark baseline, then tree-bisect the Overview culprit at ~367 px.
3. Fix with the app's own idioms: flush wrapper for the genuinely-wide AnalyticsView tables; `overflow-wrap: anywhere` on `.table td` (wrapping suffices for 2–4 column tables — no nested scrollbars); `.statgrid .stat { min-width: 0 }` + value ellipsis guard; `min()` caps; `.stage` completed with `display: grid` (the rule's stated intent) or deleted.
4. Tests: markup pins for every touched file (chrome-markup/ds-markup idiom, `?raw` source tokens) + an AnalyticsView mount test (it has zero coverage today) + extend shaped tiers where touched.
5. Validate: pnpm test/build, .agentic/bin/validate, docs-check, live post-fix sweep = the AC bar.

## Validation

- **Live sweep (the AC bar):** baseline 90 combos → **22 overflowing** (overview at every width, benchmarks and node ≤480); post-fix **88 combos (11 routes × 320/390/480/720 × light+dark) → 0 overflowing** (`documentElement.scrollWidth ≤ innerWidth` everywhere). Vite dev + TCP forwarder against the DEV hub (irori-web-browser-verify option A); residuals chased by tree-bisect to named culprits (tip pseudo-tooltips, visually-hidden ICB escape, nowrap cell min-contents, barrow auto column) and re-swept.
- **Tests:** `pnpm --filter @irori/web test` 480 passed / 57 files, including `test/overflow-sweep-ir196.test.ts` (8 structural pins + the first AnalyticsView mount — zero-coverage ratchet). Full workspace: core 110, agent 268, proxy 24, server 232 passed / 164 skipped (db-gated; no local `IRORI_TEST_DATABASE_URL` — CI runs them), db 8 passed / 7 skipped. `pnpm build` ✓, `.agentic/bin/validate` ✓, `.agentic/bin/docs-check` ✓.
- **Visual:** overview@367, serve@320, usage/analytics@320 screenshots — contained and legible; tooltips verified no-box-at-rest + hover rule present. Serve `.stage` rows absent in current DEV data (only render during stage progression) — the completed rule is pinned by markup and was constructed to the rule's stated intent; flag if a live stage row looks wrong after deploy.
- **Out-of-scope defect found while verifying (reported, not fixed here):** `GET /api/v1/analytics/efficiency` and `/api/v1/analytics/token-reconciliation` return **400 "unknown lens"** on the live hub — the `/api/v1/analytics/:lens` catch-all (app.ts:763, M7 `98797ec`) is registered before both concrete routes (app.ts:1513/1544, IRI-071/073 `8ffebb7`) and shadows them, so the AnalyticsView tokens lens can never render its reconciliation/efficiency sections from live data (the whole tokens section errors out). Needs its own ticket: route order + server regression test.

## Review

- Correctness: every fix is measurement-driven (hide-subtree bisect + containment experiments: `contain:paint` vs `overflow:hidden` isolated the abs-pos ICB escape; hiding the 8 tips alone collapsed overview 588→367), not guessed. Class-closure rules (`td` anywhere, statgrid guard, visually-hidden origin, tooltip display:none) close the defect class app-wide; AnalyticsView uses the app's existing flush idiom, live-verified on the UsageView errors table (internal scroll + sticky first column + page contained).
- Security: n/a — CSS/template containment only; no API, auth, or behavior changes beyond layout.
- Compatibility: desktop untouched (>720: `.model-repo` keeps nowrap+ellipsis at the 340 cap; barrow auto column still sizes to content when space allows; `.stage` rule is ≤720-only). Web-only deploy; next tag `dev-0.6.0-3`; rollback = previous tag.
- Residual risks: the tokens-lens 400 above masks its sections until the server route-order fix lands; serve `.stage` visual unverified on live data (see Validation); db-gated suites skipped locally (CI covers); the sweep reflects DEV data — a future fixed-width element could reintroduce overflow (pins + the sweep recipe catch it).
