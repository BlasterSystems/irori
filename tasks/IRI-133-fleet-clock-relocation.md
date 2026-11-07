# Task: Fleet clock section relocation per approved option A (IR-198 / S3 of IRI-130 round 7)

## Objective

Implement the owner-approved **CLOCK A** pick (2026-11-07) from `mockups/IRI-130-mobile-shell-clock-options.html` S7 + the shared S6 rules: the fleet clock caps card moves **below Nodes and Power** on the Overview, is **hidden entirely when `sparkNodes.length === 0`**, and per-node apply outcomes become **touch-legible rows** (not `title`-only chips). Node-level clock cards in NodeDetail's History CPU/GPU cards are untouched.

Design authority: `docs/research/IRI-130-ui-feedback-round-7-research-brief.md` §5.2 (task IRI-130), mockup S6/S7 scenes. Option A scene note fixes the page order: **temperatures → heroes → nodes → power → clock caps → updates → feed**.

## Acceptance criteria (IR-198)

- [ ] Section renders only in the approved location (after Power, before Updates) and is hidden entirely when there are no spark nodes
- [ ] Per-node apply outcomes legible on touch (not title-only chips)
- [ ] Fleet apply 200/207/502 semantics and the error banner preserved
- [ ] Drift state reachable per the approved design (unchanged: `clock_cap_drift` warn chips on NodeDetail; option A adds no drift UI)
- [ ] A new mount test covers the section (first coverage — currently zero); node-level History cards untouched

## Files

- `apps/web/src/components/OverviewView.vue` — template move + `v-if`, outcome rows, helper, scoped CSS. Script logic (`applyFleetCaps`, refs, 200/207/502 handling) unchanged.
- `apps/web/test/overview-fleet-clock-ir198.test.ts` — new: DOM-order, hide-when-empty, touch-legible outcomes, error-banner tests.

## Non-goals

- No server/API/db changes (IR-189 semantics already covered server-side by `clock-caps-ir189.test.ts`).
- Node-level clock cards (`NodeDetail.vue`) untouched.
- No drift UI added to Overview — option A keeps the card as-is; drift stays on the node page per the approved design.

## Plan

- [x] Understand requirements (brief §5.2, mockup S6/S7, current template 536-576)
- [x] Confirm architecture impact — none (presentation-only, web-only)
- [x] Implement the smallest complete change
- [x] Add mount tests
- [x] Update docs (task file; no ADR — no architectural impact)
- [x] Run validation

## Architecture impact

- **ADR required:** No — presentation-only relocation within one view.

## Decisions

- **Option A = one template move + S6 rules.** The card itself is unchanged (same controls, same Tip, same 200/207/502 handling); only position, empty-fleet hiding, and outcome legibility change.
- **Outcome rows replace chips.** Per the S6/S8 row idiom (`.orow`: dot + node name + visible per-side detail). Detail text reuses today's title string shape (`side: ok|error`) because `FleetClockCapNode.results` carries `{side, ok, offline, error}` — no applied-cap value to render (mockup's "GPU 2000" style detail would need data the API does not return).
- **`role="status"` on the fleet status line** matches the mockup's status line treatment; `fleetError` banner unchanged.
- **Drift reachability:** unchanged per approved option A — NodeDetail warn chips remain the drift surface; the card's Tip still explains re-assertion.

## Validation evidence

- **Typecheck:** `pnpm typecheck` ✓ all packages (first run caught TS2532 `noUncheckedIndexedAccess` on `rows[0]`/`rows[1]` — fixed with non-null asserts).
- **Tests:** full workspace `pnpm test` **EXIT=0** — core 12 files, db 2+1 skip, proxy 4, **web 58 files** (incl. new `overview-fleet-clock-ir198.test.ts`: 4 tests), agent 21, server 28+19 db-gated skip.
- **Build:** `pnpm build` ✓ (vue-tsc + vite + esbuild).
- **Config validation:** `.agentic/bin/validate` ✓. **Docs check:** `.agentic/bin/docs-check` ✓ (1 changed file, no gaps).
- **Live (vite + TCP forwarder → DEV hub `dev-0.6.0-3`):** Overview DOM order `clock=4 > power=3`, `clock < updates=5`; card head "3 spark nodes"; `scrollWidth == innerWidth` at 320/390 light+dark; screenshots confirm the card below Power/NAS and above Updates. Outcome rows not exercised live (clicking Apply/Clear would mutate the real fleet's caps) — covered by the mount test instead.

## Review

- **Correctness:** one template move + `v-if="sparkNodes.length > 0"` + outcome rows; `applyFleetCaps` and the 200/207/502 handling are untouched; `fleetMsg` gains `role="status"` (mockup status-line idiom); `fleetError` banner unchanged. Outcome detail reuses the exact string today's chips carried in `title`, now visible.
- **Security:** n/a — presentation-only; no API/auth/data change.
- **Compatibility:** web-only; next tag `dev-0.6.0-4`; rollback = previous tag. NodeDetail History CPU/GPU clock cards untouched.
- **Residual risks:** outcome detail is the API's own error text (can be verbose — wraps via `overflow-wrap: anywhere`, no overflow at 320/390 measured). Drift remains a NodeDetail-only surface per approved option A (acceptance met: drift state reachable, unchanged). If the owner later wants applied-cap values in rows ("GPU 2000"), the API response needs the value per side — filed as **IR-199**, out of scope here.
