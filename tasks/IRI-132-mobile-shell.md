# Task: Mobile topbar buttons + footer per approved mockup (IR-197 / S2 of IRI-130 round 7)

## Objective

Implement the owner-approved S0 picks (2026-11-07: **footer B1, band keep**) from `mockups/IRI-130-mobile-shell-clock-options.html`:

1. **S1 tap floors** — every topbar interactive control ≥44px on tiers under full (theme + gear join the hamburger; ≤720 was already covered by the shared `.iconbtn` rule in irori.css — the real gap was 721–1440, small/medium tiers).
2. **S2 footer B1** — small-tier (`data-tier="small"`) footer is ONE row: `version · watts` (wordmark, deploy tag, cadence dropped); below 390px only watts stay; footer CTAs are bordered `btn--secondary` with the 44px floor; the deploy tag's committed home is a `menudeploy` line at the bottom of the hamburger menu (so deploys stay verifiable by tag).
3. **S5 band decision: KEEP** — no consolidation of the 721–900 band (recorded decision; no code change).

## Files

- `apps/web/src/assets/irori.css` — `.menudeploy` rule (next to the `.navmenu` block).
- `apps/web/src/App.vue` — scoped chrome rules (topbar floors, small-tier CTA floor, `.pv-ver` ≤389 hide), footer markup split (small vs full line), `menudeploy` in the navmenu, CTAs `btn--ghost` → `btn--secondary` (approved scene).
- `apps/web/test/chrome-markup.test.ts` + `apps/web/test/ds-markup.test.ts` — pins (AC).

## Acceptance criteria (IR-197)

- [ ] 44px touch floors on all topbar interactive controls (not just the hamburger)
- [ ] Footer height and typography match the approved B1 scenes at 320 and 390 (one row ≈60px + safe area, CTAs 44px, version hidden <390, watts stay)
- [ ] 721–900 band resolved per S0 decision (keep — documented)
- [ ] `chrome-markup.test.ts` / `ds-markup.test.ts` pins updated

## Non-goals

- IR-198 (clock relocation) — untouched. Node-level clock cards untouched. No server/API/db changes. The 721–900 band density stays as-is (S0 decision), the footer/topbar chrome on small tier follows B1/S1.

## Decisions

- **B1 scope = data-tier "small" (≤900).** The mockup depicts phones; the topbar floors explicitly say "on small tiers", and the footer chrome is data-tier-driven like the 12px gutters. Full+medium tiers keep the full version line. The 721–900 band keeps its desktop density blocks (S5 keep) — chrome follows the tier, blocks don't reflow.
- **CTA variant `btn--secondary`** per the approved scene markup (was `btn--ghost`); bordered CTAs read as buttons on the sticky footer, which is the point of the B1 scene.
- **`serverTag` fallback "unknown"** in `menudeploy` (tag loads async from `/api/v1/version`).
- The offline chip is unchanged (S1 scene note: keeps `flex: none`, wraps the row when present).

## Validation

- **Live (vite + TCP forwarder against the DEV hub `dev-0.6.0-2`, per irori-web-browser-verify option A):** 320 px → topbar `44/44/44`, footer **61px one row**, `pv-ver` `display:none` (watts stay "204 W"), sw 320=320; 390 px → 44s, one row, `pv-ver` inline ("0.6.0 · 206 W"); 768 (small band) → 44s, compact footer, hamburger menu shows `deploy dev-0.6.0-2` (menudeploy, visible, Escape closes); 1280 (medium) → 44s + full footer line (tier floors correct); **1568 (full) → 34px buttons, full line "Irori 0.6.0 · dev-0.6.0-2 · updates every 1 s · 222 W" — desktop untouched**; dark theme at 390 ✓. `scrollWidth ≤ innerWidth` at every width.
- **Tests:** `pnpm --filter @irori/web test` **481 passed** (57 files) — new chrome-markup IR-197 test (S1 floors, B1 line/`pv-ver`/`menudeploy`/secondary CTAs) + ds-markup `.menudeploy` verbatim pin; full workspace: core 110, agent 268, proxy 24, server 232/164 skipped (db-gated, CI), db 8/7 skipped. `pnpm build` ✓ (after final src edit), `.agentic/bin/validate` + `.agentic/bin/docs-check` ✓.
- **Band decision (S5 keep):** no consolidation — the 721–900 band keeps its density blocks; chrome (44px floors, compact footer, gutters) follows `data-tier` small as approved. Documented here and on the ticket; revisit only if the 784px density is ever complained about.

## Review

- Correctness: implemented exactly the approved S1/B1 scenes (mockup lines 217–298 + scene notes); footer math matches (8px pad + 44px CTAs ≈ 61px measured vs the scene's ≈60px); the tag has a committed home before the footer drops it; `serverVersion ?? "…"` guards kept; watts retained on all tiers (no off-Overview surface loss).
- Security: n/a — presentation-only; no API/auth/behavior change.
- Compatibility: full tier byte-identical behavior (34px buttons, whole version line, no menu); medium keeps the full line with new 44px floors; ≤720 unchanged besides CTA variant. Web-only; next tag `dev-0.6.0-3`; rollback = previous tag.
- Residual risks: CTA `btn--ghost` → `btn--secondary` is the one visible deviation from the pre-B1 desktop-adjacent look (approved scene markup); if the owner prefers ghost it's a one-class revert. `menudeploy` shows "unknown" until `/api/v1/version` resolves (async load, transient). IR-198 (clock relocation) is deliberately untouched.
