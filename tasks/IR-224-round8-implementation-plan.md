# Task: IR-224 round 8 implementation plan (S4–S8)

Epic: [IR-224](https://blastersystems.atlassian.net/browse/IR-224) — DS v1.4 adoption + shell controls round (UI feedback round 8). All stories on the backlog (To Do); plan written 2026-11-13 after the second owner mockup pass. Validated decisions live in `tasks/research-ds-v14-ui-feedback-round-8.md` (gate + both revision passes); the approval surface is `mockups/v14-round8.html` (full deployed Overview + the round-8 delta; record in `mockups/PLAN.md`).

## Status gates (before code)

1. **Mockup approval** — owner signs off on the revised full-page `v14-round8.html` (S1 deliverable, IR-225).
2. **Jira writes pending owner OK**: revision comments on IR-224/228/230/231 (ticket texts still describe the first-pass scope); close calls on IR-226/IR-227; sprint placement at next planning (gate: backlog, no sprint).
3. Per the implement flow, each starting ticket gets its own `tasks/IR-22X-*.md` from `tasks/task-template.md`; this file is the epic-level plan.

## Second-pass scope corrections (override the ticket texts)

1. **Perf chip (IR-228)**: hidden on the Overview — its serving heroes already carry decode + watts; appears on every other route. (Ticket says "topbar time span + Add node CTA"; corrected: range + Add node live in the MENU, topbar gains the chip.)
2. **Power card (IR-230)**: pinned to the 24 h window — default and when 30 m is selected; it does not follow the menu range. Energy, cost, hourly chart and window avg are always 24 h. (Ticket says "cards and heroes" follow the range; corrected: serving heroes follow, power is pinned.)
3. **Token stats card (IR-231)**: its own row directly BELOW the NAS card; production keeps the deployed `hero-grid` pairing Power | NAS (`OverviewView.vue:613`) and adds the token row after it. (Mockup position, not power's slot.)
4. Themes: the v1.4 four-step scale is declined — the app keeps the deployed v1.1 light/dark palette and toggle. IR-226 (ADR-0019) and IR-227 (S3 tokens/themes) are obsolete as written; owner to close. S8's "four-theme sweep" becomes the deployed two-theme sweep.

## Untouched surfaces (the "focused change" contract)

Nothing outside the round-8 delta changes: IR-203/204 health banner (with the clean-up-disk CTA), Fleet temperatures (IR-129), Nodes cards, Fleet clock caps, Updates (IRI-081), the Telemetry feed, refresh-note, all page CTAs, and every other route's IA. The revised mockup now renders all of them 1:1 with `OverviewView.vue` order (pagehead → banner → temps → heroes → Nodes → Power|NAS → token → clock caps → Updates → Telemetry → footer) so future reviews are on the true full page.

## S4 — Shell (IR-228): menu tools + collapsible rail + perf chip

**Files**: `apps/web/src/App.vue` (shell/sidebar/topbar/hamburger, :160-231), `apps/web/src/assets/irori.css` (collapse rules, menu tools, `.bs-perf` chip, icon sizing), new vendored icons (`apps/web/src/assets/icons/*.svg`, ~10 nav glyphs — local SVGs, never the kit's jsDelivr CDN), new `apps/web/src/range.ts` (`irori.range` store: persisted, try/catch pattern; S4 owns control + store).

**Key changes**
- Collapsed icon rail ≥901 (~68px): mark-only brand, icon nav items with count bubbles, aria-labels, persisted `irori.sidebar.collapsed`; ≤900 hamburger unchanged (IR-197/IR-132 contract).
- Range seg + Add node move OUT of the Overview pagehead (`OverviewView.vue:525-534`) into the sidebar tools block; hamburger menu carries them ≤900; collapsed rail shows an Add node icon button + a JS-positioned range popover (`position: fixed`, escapes the rail's `overflow-x: hidden` clip — mockup-verified mechanic).
- Topbar `.bs-perf` chip: live decode + watts of the serving setup; `v-if="route.name !== 'overview'"`; model name hidden ≤900; links to Serve.
- Add node opens NodeModal from any route (ghost/secondary chip; page CTAs like Serve's "New setup…" unchanged).

**Tests/docs**: rewrite `ds-markup.test.ts:77-85` (.shell grid pin) for the collapsed variant; chrome-markup topbar floors; new pins — chip absent on Overview route, present on others, tools live in the menu. `docs/CONFIGURATION.md` for the relocated controls + chip. ACs per IR-228 plus the chip-visibility correction.

## S5 — Cleanup drawer (IR-229): unchanged scope

Fixed header + body scroll region + sticky typed-confirm; staging/quarantine/prevention into accordions; reuse the unused `.drawer__body` hook (`irori.css:494`); give ALL eight `.drawer` instances the `__body` wrapper; reconcile the pre-existing ≤720 `visibility` gate (`irori.css:486-487` — five instances statically invisible on phones); CleanupDrawer gains `v-dialog` + `aria-modal` (Escape/focus parity with ServeView). Job flow, endpoints, typed confirms unchanged. Rewrite `chrome-markup.test.ts:100-105` (verbatim `.drawer` rule pin) and the cleanup harness tests. The deployed Audit/History tab strip (`CleanupDrawer.vue:304-307`) is not depicted in the restructured mockup; S5 keeps the tabs — job flow unchanged. Blast radius and ACs exactly per the IR-229 text.

## S6 — Range (IR-230): 24h default, heroes follow, power pinned

**Files**: `apps/web/src/components/OverviewView.vue` (range plumbing :96-97/:378-381, power card :613-670), `packages/core/src/analytics.ts` only if a helper is missing, `apps/web/src/assets/irori.css` (nothing), tests.

**Key changes**
- Consume the S4 `irori.range` store; default flips 30m → **24h**; heroes (fetchLlmHistory :196) and the token card fetch follow it — one persisted range, IR-128 contract moves to the menu, not removed.
- **Power card decoupled**: energy/cost/hourly chart/window avg fetch a fixed 24 h window regardless of the store (labels drop the `rangeLabel` binding, `:619-620`).
- **Fleet now + per-node barrows** (`:620-634`) stay now-surfaces from an always-fresh source (separate 30m power series or `live.snapshots`) — never hour-stale averages (hub returns hour buckets at 24h, `analytics.ts:50-53`).

**Tests**: rewrite `overview.test.ts:283/:318-323` shared-range pins for the store + add: fresh load defaults 24h, power card window stays 24h at every range, Fleet now freshness independent of range.

## S7 — Token stats card (IR-231): position corrected

**Files**: `apps/web/src/components/OverviewView.vue` (insert own `hero-grid` row directly after the Power | NAS row, :613-703; NAS keeps models/store — its token block :690-698 is removed), `apps/web/src/tokens-data.ts` (fleetTiles: per-stat deltas via one prev-window `offsetMs` fetch, cache-hit delta in points, Output:input / Avg-per-hour / Busiest-hour folds, granularity-aware busiest-day relabel), `apps/web/src/assets/irori.css` (`.stat__delta` DS-calm mono deltas — mockup-verified).

Content per the approved mockup: 8 tiles (Total, Generated, Prompt, Cached, Cache hit, Cost, Avg/hour, Busiest hour), all-nodes fleet scope (documented change from the spark-only NAS fold — server aggregate already sums every ledger node, `analytics.ts:141-156`), follows the shell menu range (default 24h) — the card consumes the same `irori.range` store the heroes use. Optional Copy CSV = new KPI-summary export; skip unless the owner asks. Tests: `tokens-data.test.ts` fleetTiles pins naming which tiles carry deltas; reconcile-with-lens check per AC.

## S8 — Closeout (IR-232): adjusted for the declined themes

CHANGELOG, docs sweep (`docs/CONFIGURATION.md` — menu controls, collapse, perf chip), final deployed two-theme (light/dark) × 320→1568 verification of every touched route, 0 console errors, epic evidence comment. `validate` + `docs-check` + `pnpm test`/`pnpm build` green. No ADR (the round introduces no durable cross-cutting decision; the record is the research doc + mockup PLAN).

## Order & process

S4 → S6 → S7 (store dependency); S5 independent (can run parallel to S4); S8 last. One branch `ir-224-ds-v14` for the epic, one commit per ticket (`type(scope): description (IR-22X)`), push + PR referencing the epic. IR-226/227 never start — owner closes them with a one-line reason. Validation per repo rules: `.agentic/bin/validate`, `.agentic/bin/docs-check`, `pnpm test`, `pnpm build`.
