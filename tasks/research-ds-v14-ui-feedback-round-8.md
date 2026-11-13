# Research: DS v1.4 adoption + UI feedback round 8 (collapse, topbar controls, cleanup drawer, colour depth, token stats, power default)

Status: **Draft for human validation** — no tickets created yet.
Round: UI feedback round 8 (after IRI-130 round 7, 2026-11-07) + DS v1.4 upgrade on top of the v1.1 skin shipped by IR-214.

## Jira target

| Item | Value | Resolved how |
|---|---|---|
| Project key | `IR` ("Irori", project id 10004) | `docs/PLAN.md:22` ("Tracking lives on Jira (project IR — Irori)"); task files `tasks/IRI-NNN-*.md` ↔ IR keys; commit subjects `(IR-NNN)` |
| Site host | `https://blastersystems.atlassian.net` | `mwa-jira-rest` Site 3 credential map (`JIRA_EMAIL_BLASTERSYSTEMS`/`JIRA_API_TOKEN_BLASTERSYSTEMS`) |
| Board id | **5** ("IR board", type simple) | Live `GET /rest/agile/1.0/board?maxResults=50` filtered on `location.projectKey === "IR"`, 2026-11-13 |
| Issuetype ids | Epic `10021` · Story `10022` · Bug `10023` · Task `10024` · Subtask `10020` | Live createmeta `?projectKeys=IR&expand=projects.issuetypes`, 2026-11-13 |
| Active sprint | **1004 "IR Sprint 4"** (2026-11-08 → 2026-11-15) | Live `GET /rest/agile/1.0/board/5/sprint?state=active`, 2026-11-13 |
| Assignee | Bruno Pires `<redacted-jira-account-id>` | Live `/rest/api/3/myself`, 2026-11-13 |
| **Created (2026-11-13, post-gate)** | Epic **IR-224** + tasks **IR-225** (S1 mockup) · **IR-226** (S2 ADR) · **IR-227** (S3 tokens/themes) · **IR-228** (S4 shell) · **IR-229** (S5 drawer) · **IR-230** (S6 range) · **IR-231** (S7 token stats) · **IR-232** (S8 closeout) — all **backlog** per gate; Relates ↔ IR-200; per-key parent verification green | Bulk payload `/tmp/irori-round8-jira.json` |

Conventions that will apply at creation: children `Task`, priority Medium, no labels, plain-text mark-free descriptions, all added to the chosen sprint including the epic (epic sprint membership verified per-key, not via the sprint list). Per repo rule and the research skill: **no Jira write without explicit owner approval in-conversation.**

## Gate decisions (2026-11-13, human validation)

**Approved: create the epic + 8 stories in IR (board 5) — backlog, no sprint (move at next planning).** Owner picks:

- **Token stats card follows the topbar range** (default 24h, persisted; no per-card chips).
- **Heroes also follow the topbar range** — one persisted range for Overview after S6, default flips 30m→**24h**; the IR-128 "one range, two surfaces" contract moves to the topbar rather than being removed.
- **Add node = ghost/secondary chip** in the topbar; page CTAs (Serve "New setup…") unchanged.
- **Colour: follow the design system in place** — no new colour roles (`--ok` dropped from scope); the four theme steps are the colour expansion; delta accents styled from existing DS tokens in the mockup (sparkDash's green is its palette, not BlasterSystems').
- **Cleanup drawer = fixed header + sticky typed-confirm + bounded body scroll** (long audits scroll internally; panel never does).
- **No new ranges** — keep 30m→30d; S8 becomes closeout-only (14d/All-time declined; revisit when a use appears).
- Defaults confirmed as applied: vendored local lucide SVGs (no CDN), auto-dark media query deleted (boot script always sets `data-theme`), legacy stored `dark`→`dusk`, Fleet-now freshness via a separate always-fresh 30m source, NAS token block folded into the new card (all-nodes scope, documented), Copy CSV optional per mockup.

## Revision (2026-11-13, post-mockup owner review)

Owner corrections against the first decision mockup — these supersede the
corresponding gate decisions:

1. **Colours stay deployed**: the app keeps the deployed v1.1 light/dark
   palette and theme toggle. No mist/stone/dusk, no theme menu, no token
   migration — the v1.4 four-step scale is declined (the v1.4 component
   CSS is identical to the deployed v1.1 port, so nothing else changes).
   Ask 4 resolves as: use the DS palette already in place (thread for
   live/current data — the deployed discipline), not new themes.
2. **Power + token stats keep their current lower positions**: Power stays
   in its hero-grid row; the new Token stats card takes the NAS card's
   token slot (NAS keeps models/store).
3. **Range + Add node live in the MENU, not the topbar** (deployed
   pagehead controls move into the sidebar tools block; the hamburger menu
   carries them ≤900; the collapsed rail shows an Add node icon button and
   a JS-positioned range popover). The **topbar instead gains an
   inference-server performance chip** (live decode + watts, all pages,
   compressed ≤900).
4. Cleanup drawer, collapsible rail, token stats content and power
   default are unchanged from the gate.

**Effect on the created stories**: IR-227 (S3 tokens + theme runtime) is
obsolete as written — propose close; IR-226 (S2 ADR-0019) is likely
unnecessary (no token migration, no cross-cutting decision beyond the
round itself) — propose close or fold into the epic record; IR-228 (S4)
scope moves range/Add node into the menu and gains the perf chip;
IR-230/IR-231 pick up the position notes. Revision comments posted on the
epic and the affected stories.

Second pass (2026-11-13, full-page mockup review): three further
corrections — (1) the perf chip is NOT on every page: hidden on the
Overview (its serving heroes carry the same data), shown once the user
navigates away; (2) the power card is PINNED to the 24 h window — by
default and when 30 m is selected it does not follow the menu range
(energy/cost/hourly chart/window avg; Fleet now stays minute-fresh);
(3) the Token stats card sits directly BELOW the NAS card (production
keeps the deployed Power | NAS hero-grid pairing; the token card is its
own row after it). The decision mockup was rebuilt to render the FULL
deployed Overview — health banner, fleet temperatures, Nodes cards,
fleet clock caps and updates are untouched surfaces the first cut had
dropped — plus the round-8 delta (mockups/PLAN.md carries the
verification record). IR-226/IR-227 remain obsolete as written.

## Summary

Six owner asks, grouped:

1. **Collapsible menu** — Irori-specific shell extension (kit silent).
2. **Time span + Add node CTA in the topbar** — Irori-specific topbar extension (kit topbar is logo + theme + menu only).
3. **Cleanup-disk drawer must not scroll as a panel** — shared-drawer restructure + a11y parity + UX pass.
4. **Use the DS's multiple colours, not just dark/white** — the v1.4 four-step theme scale (light/mist/stone/dusk) + data-colour roles (ok/warn + thread), replacing the current effective ink/paper monochrome.
5. **Token stats own card, default 24h** — sparkDash-inspired KPI card on Overview (reference: `local://pasted-image-ee37ec891c16acf7.png`); all data exists server-side (fleet aggregates + `offsetMs` delta support); output:input / avg-per-hour / busiest-hour are client-foldable; 14d/All-time ranges are optional small server additions.
6. **Fleet power default 24h** — per-card defaults (heroes keep 30m "now" freshness).

v1.4 delta vs the shipped v1.1 skin is small and additive: four theme steps + `--control` outline tokens + the ThemeToggle menu runtime (`navigation.css`/`brand.css` unchanged — already ported by IR-216/217). A new ADR supersedes ADR-0018 (its revisit trigger fires). Feasibility for every ask is confirmed against the current code; the only genuinely open items are design-shape decisions for the mockup round, listed under Open questions.

## Current state (evidence)

Fact sheets by two read-only scouts (ChromeScout, TokenPowerScout), spot-verified. File:line as of main `3a02e2c` + DS v1.1 epic.

### Shell / nav / topbar

- `apps/web/src/App.vue` renders the whole shell: `div.shell` grid (`--sidebar-width` 232px + content) → `aside.bs-sidebar` (App.vue:160-188) + `header.bs-topbar` (App.vue:193-231) + routed views. No separate Shell component. CSS: `irori.css:117` (grid), `:121-123` (sticky sidebar), `:154-156` (sticky topbar).
- Nav items + count badges (App.vue:171-182, duplicated verbatim in the hamburger menu :216-230): Overview (live node count), Models (`modelsTotal`), Serve (`setupsTotal`), Analytics, Usage, Chats, Benchmarks, Audit, Logs, Community. Counts are totals only (IR-214 shell contract, App.vue:60-62), refetched on route change + SSE reconnect (:94-105).
- Tier machinery `apps/web/src/tiers.ts:18-38` (small ≤900 / medium / full → `html[data-tier]`, not persisted). ≤900: sidebar hidden, hamburger menu instead (`irori.css:472-477`); drawer is session-only `navOpen` (App.vue:79), closes on outside/Escape/route/tier-change (:85-111).
- **No collapse capability exists**: no icon rail, no persisted nav state. Persistable UI-state precedents: `irori-theme` (index.html:8 boot + App.vue:128-139), `irori.models.sort` (ModelsView.vue:55-62/172-177), `irori-telemetry-w` (TelemetryDrawer.vue:15-46) — all try/catch-wrapped.
- Topbar today: hamburger (≤900), brand lockup (≤900), Offline chip, Transfers + countbub, Telemetry, gear → HubSettingsModal, `.bs-theme` half-moon toggle (App.vue:194-214). Sidebar foot: live status, `Irori {version} · {tag}`, watts (App.vue:183-187).
- "Add node" today: **pagehead button on Overview only** — `btn btn--primary` "Add node…" (OverviewView.vue:534, `addOpen` :337) mounting `<NodeModal mode="create">` (:781). NodeModal reveals one-time token + agent installer block (NodeModal.vue:66-135). The `.afford` pagehead chip exists only in the IRI-130 mockup, never shipped.
- Pagehead idiom: `div.pagehead` → left (h1+p) + right `.row` of actions; used by every view (OverviewView.vue:515-519, ServeView.vue:900-905, ModelsView.vue:1173-1177, …).

### Cleanup drawer (ask 3 subject)

- Component: `apps/web/src/components/CleanupDrawer.vue` (560 lines), bottom-anchored **drawer** (`.drawer-scrim` + `aside.drawer is-open`, CleanupDrawer.vue:293-294). Uses `v-scrim-close` only — **no `v-dialog`** (no Escape, no focus trap) and no `aria-modal`, unlike ServeView's drawers (ServeView.vue:1023, 1105).
- Sizing/scroll: shared chrome, no scoped overrides (`irori.css:345-347` comment states so). The panel itself scrolls: `.drawer { width: min(560px,100%); max-height: 88vh; overflow: auto; … }` (`irori.css:348-352`). Content stack: header + tabs + intro (:301-311), N audit category rows with checkbox lists + bars (:321-371), sticky typed-confirm gate (`.hy-confirm` position:sticky bottom:0, :552-556), staging/quarantine section (:399-…), run output `pre` capped 220px (:477), prevention block (:479-492). Whenever the stack exceeds 88vh (small viewports, long audit lists), **the whole drawer scrolls** — the reported defect.
- Entry points (4): HealthBanner CTA "Clean up disk — est. +{fmtBytes}" (HealthBanner.vue:107-113, mounted from OverviewView :541), NodeDetail "Disk hygiene" (NodeDetail.vue:972-975), ModelsView placements inline "clean up disk — run audit" (ModelsView.vue:1465), ServeView capacity-failed rows "Clean up disk — est. +…". (ServeView.vue:1244-1246.)
- Flow (job-based): `GET /api/v1/nodes/:id/cleanup` → `{latestAudit, history, prevention}` (api.ts:951-964); job kinds `hygiene-audit`, `hygiene-clean {categories, dryRun:false}`, `hygiene-prevent`, `staging-tree-audit`, `quarantine-prune`, `prune-cleanup-quarantine` (CleanupDrawer.vue:45, 112-155). Typed node-name confirm gate (:374-396), per-tree arm+typed-name prune (:440-459), weekly safe-pass toggle via `PUT /api/v1/nodes/:id/hygiene` (api.ts:966-975).
- Modal/drawer inventory: NodeModal `max-height: 92vh; overflow: auto` (NodeModal.vue:225-231), HubSettingsModal (no max-height ≥721), ModelsView drawer 86vh auto + confirm-card 86vh, wizard 92vh with sticky head/foot (ServeView.vue:1506-1525). Shared helpers: `v-scrim-close` (scrim.ts:13-33), `v-dialog` APG dialog (dialog.ts:17-79) — **used only in ServeView**.

### Colour usage (ask 4)

- `apps/web/src/assets/irori.css` carries v1.1 oklch tokens verbatim: light `:root` (:21-33), dark via `@media (prefers-color-scheme: dark)` auto (:35-46) + explicit `[data-theme="dark"]` (:47-56). No mist/stone/dusk. No `--control`.
- **`--accent` renders as ink**: `:root` sets `--accent: var(--thread)` (:33) but the later Irori alias block overrides `--accent: var(--ink)` (:84) — deliberate v1.1 decision (thread never a fill). `--success: var(--ink)`, `--warning: var(--ink-2)`, `--error: var(--thread)` (:85).
- Chart series palette is a TS constant, neutral inks + thread: `["var(--thread)","var(--ink-2)","var(--ink-3)","var(--ink)","var(--thread-ink)"]` (analytics.ts:56-62). No `--c1…--cN` tokens exist. Hue (thread) appears only as line/live/warn chrome (nav rail, focus, warn chips, banners, stale cards, destructive links, log `.err`/`.ok` — irori.css:296-343, 397).
- Net: **ink/paper monochrome + one thread hue**; the ok/warn/crit semantic aliases are ink/ink-2/thread, so stat-level colour (e.g. green deltas) does not exist outside the force-dark log console (`.ok #9cc29c` ratified IR-214, irori.css:337).
- Dead (defined, never referenced): `--band`, `--surface-page/card`, `--text-1/2/3`, `--border-1/2`, `--accent-text/wash/fg/soft`, `--grid-cell`, `--hairline`, `--fs-endorse`, `--tracking-mono`, `--lh-ui` (token-wide grep).
- Theme boot: index.html:8 inline script — stored `irori-theme` else `prefers-color-scheme: dark → dark`. Values today: `light|dark` only (App.vue:134-135).

### Token stats / fleet power / ranges (asks 5-6)

Two data streams: **token ledger** (probe counters → `llm_snapshots.tokens {generated,prompt,cached}` → hub `token_ledger` per node×port×model in minute/hour/day buckets — `packages/core/src/llm.ts:45-53`, `apps/server/src/ledger.ts:7-11,54-58,109-130`) and **capture proxy** (`llm_requests` + `usage_buckets`, hour/day — ADR-0008/0010).

Token surfaces today (all of them):

| Surface | Data | Default range |
|---|---|---|
| Overview NAS card "Tokens · {range}" block (OverviewView.vue:704-716; `tokenTotals` overview.ts:241-257) | `GET /api/v1/analytics/tokens?range=&groupBy=node` | shared Overview range (**30m**) |
| Analytics tokens lens: 6 fleet macro tiles (Total/Generated/Input computed/Cached/Cache hit/Cost) **with delta% vs prev** (AnalyticsView.vue:186-191, 244-262; `fleet` analytics.ts:137-176) | same endpoint + 2nd fetch with `offsetMs` | **24h** (RANGE_TABS 1h/24h/7d/30d/90d, analytics.ts:21) |
| Analytics: by cluster/node/setup table, per-model ledger table, cost+token trend charts, reconciliation | same response + `/api/v1/analytics/efficiency`, `/token-reconciliation` (server default 4h) | 24h (lens) |
| Usage overview KPI grid + charts (UsageView.vue:376-438) | `GET /api/v1/usage/overview` (`kpis{prompt,completion,cached,reasoning,total}`) | **24h**, persisted in URL hash (usage.ts:13-30) |
| Chats per-session tokens (ChatsView.vue:141) | `/api/v1/usage/chats` | 24h |

- IRI-040 deliberately placed macro token views inside the Analytics **tokens lens** (standalone Tokens page removed before merge; tasks/IRI-040:5-12,27-29). There is **no token card on Overview** today.
- Delta machinery exists: `offsetMs` shifts the window server-side (app.ts:778-780, analytics.ts:36-39,96); the % delta is client math (AnalyticsView.vue:186-191, label `tokens-data.ts:80`).
- Not computed anywhere: output:input ratio, avg tokens/hour, busiest hour (grep-verified). All three are client-foldable from the bucketed `series` the API already returns (avg/h = total/hours; busiest hour = argmax bucket; ratio = generated/prompt). "All time" does not exist (max 90d); 14d exists nowhere.
- **Fleet power** (OverviewView.vue:610-676): statgrid (Fleet now / Energy·range / Cost·range), per-node barrows, IR-220 labeled bar chart, hover charttip. Data `GET /api/v1/analytics/power?range=&groupBy=node` (OverviewView.vue:298-300) → server folds `gpuPowerW+packagePowerW+40W base`, clamped 240W envelope (analytics.ts:226-244). REST-polled (60s), never SSE.
- **Overview range state**: single shared `range = ref("30m")` (OverviewView.vue:96-97) drives power, tokens and hero history; seg buttons at full tier / `<select>` below full (:525-533, IRI-046/IR-128); `OVERVIEW_RANGES = 30m/1h/4h/24h/7d/30d` (overview.ts:151-158); **not persisted**; `watch(range)` → refetch (:378-381).
- Range machinery elsewhere: Analytics `RANGE_TABS` 1h/24h/7d/30d/90d default 24h (analytics.ts:21, AnalyticsView.vue:35); Usage `USAGE_RANGE_TABS` same, URL-hash-persisted (usage.ts:13-30); node-detail `HISTORY_RANGES` 30m…90d (api.ts:520-529); API-level sets `ANALYTICS_RANGES` 30m…90d (packages/core/src/analytics.ts:19-20), `USAGE_RANGES` 1h…90d (usage-api.ts:10-12). **No range lives in localStorage**; only Usage/Chats/Audit persist via URL hash.

### DS v1.4 kit (source: `~/Developer/design-BlasterSystems/BlasterSystems design system direction v1.4/`, dated 2026-11-13)

- `tokens/colors.css`: four theme steps — `light` (default), `mist` (cool grey light), `stone` (warm paper), `dusk` (dim slate) — plus `dark` for fixed artboards only. Every scope re-declares the aliases; **`--control`/`--border-control` added in every scope** (3:1 outline colour for interactive controls).
- `components/actions/ThemeToggle.jsx`: half-filled-circle button → menu of the four steps (`role=menuitemradio`, swatches, `aria-checked`), applied to nearest `data-theme` scope, 300ms fade via `data-theme-fading`, remembered under a per-scope storage key. Boot rule: stored pick → else light, **and a light scope on a dark-mode device opens on dusk**.
- `components/overlays/Dialog.jsx` + `overlays.css`: centered `bs-dialog width:min(100%,440px)`, content-sized (no max-height — the panel never scrolls because content must fit; the Irori drawer equivalent needs an explicit body-scroll pattern).
- `components/display/StatCard.jsx` + `display.css`: `bs-panel bs-stat` — label + optional InfoTip, `bs-figure` value, optional held chip, `sub`, and a `basis` Mark (■ recorded / ○ estimated / ◇ needs you). This is the v1.4 KPI-card primitive — a direct match for the sparkDash-style token stats card.
- `components/navigation/Sidebar.jsx`: **no collapse affordance** (kit rule: app sidebar becomes top bar <800px; Irori's own tier is 900px). `TopBar.jsx`: logo + ThemeToggle + Menu only — Irori's topbar already exceeds the kit's; app-level actions in the topbar are an Irori extension consistent with ADR-0018 ("sticky topbar (page actions, …)").
- vs the shipped v1.1 port: `tokens/typography.css`, `spacing.css`, `effects.css`, `navigation.css`, `brand.css` unchanged; the Irori delta is colors.css (mist/stone/dusk + `--control`), actions.css (theme menu + fade + `--control` outlines), base.css (dusk joins dark as a dark ground for `.on-dark`). Verified against the v1.4 website adoption research (BlasterSystems repo `tasks/research-ds-v1.4-website.md`, "DS v1.4 package vs repo" diff section).

## Gap analysis (per ask, with PM / UI-UX / engineering lenses)

### 1. Collapsible menu

- **PM**: buys ~164px of horizontal data room on 1280–1440 screens (hero cards, models table, charts); zero workflow change; low risk. No competing epic.
- **UI/UX**: collapsed = icon rail (~68px): brand mark only, nav items centered icons with count bubbles, foot keeps pulse + watts glyph; labels via `aria-label` + `title`/tip. Persist the pick (`irori.sidebar.collapsed`); ≤900 unchanged (hamburger already owns small). Toggle affordance in the sidebar (chevron button, `aria-expanded`).
- **Eng**: pure CSS + one ref: `--sidebar-collapsed-width` var swapped on `html[data-nav="collapsed"]` (grid-template-columns), 150ms width transition (kit motion rule); counts refetch logic untouched; test pins for collapsed rendering; localStorage precedent exists (models.sort).

### 2. Time span + Add node CTA in the topbar

- **PM**: range + node onboarding become reachable from anywhere; today Add node lives only on Overview (OverviewView.vue:534) and the range resets to 30m every visit. Node onboarding is the platform's growth loop — topbar placement matches its importance.
- **UI/UX**: topbar gains (a) a compact range control — seg at full tier, native `<select>` below full (the IR-128 pattern), visible on data views (Overview at minimum); (b) an Add node CTA. One-filled-per-surface: topbar Add node would become the chrome's filled button — the only pagehead filled primary today is Serve's "New setup…" (ServeView.vue:909; ModelsView's pagehead has no action row — its filled "Download from HF…" sits in the toolbar, ModelsView.vue:1292), so the mockup decides Serve-pagehead demotion vs a ghost topbar CTA. Small tier: topbar is at 44px floors and already crowded — icon-only Add node or a hamburger-menu home, decided in the mockup.
- **Eng**: NodeModal is already a global component (mounts anywhere); moving the trigger is mechanical. Range: promote Overview's `range` ref to a persisted store (`irori.range`, try/catch pattern) written by the topbar control; Analytics/Usage keep their own sets (different granularities + URL persistence — IRI-046 deliberately kept them per-view).

### 3. Cleanup-disk drawer scroll

- **PM**: the drawer is the operator's main reclaim path (4 entry points); a whole-panel scroll on small viewports hides the typed-confirm gate and reads as broken. IR-200 (open epic, disk-pressure visibility with operator CTAs) will add more CTA surfaces — the drawer must be trustworthy first (Relates link, not a duplicate).
- **UI/UX**: restructure to fixed header (node, est. reclaim total, weekly-prevention toggle) + **body scroll region** + sticky typed-confirm footer; collapse staging/quarantine/prevention into accordions so the default view fits without scrolling; run output already capped at 220px. Add `v-dialog` (Escape/focus trap) + `aria-modal` — parity with ServeView's drawers. The shared `.drawer` chrome gets a `__body` region so every drawer follows "panel never scrolls, body does".
- **Eng**: CSS restructure of shared `.drawer` (flex column, `__body { flex:1; overflow:auto }`) + scoped max-height; affects ModelsView/ServeView drawers intentionally (same rule); job flow, endpoints, confirm gates unchanged; test pins updated.

### 4. Multiple colours

- **PM**: "not just dark and white" = two things: four theme steps the visitor picks (v1.4's core addition), and colour that carries meaning in data (sparkDash reference: green deltas, amber accents). Both raise perceived quality at low cost; neither adds workflows.
- **UI/UX**: adopt the four steps verbatim + the ThemeToggle menu (replaces the half-moon toggle). For data colour: introduce an Irori-owned `--ok` per theme for positive/delta signals (token-stat deltas ▲, cache-hit positives, "ok" chips) — the log green `#9cc29c` is already ratified on dark; a light-theme variant needs contrast checking (oklch→sRGB composite per theme — the IR-214 verification recipe). Chart series palette stays neutral+thread (thread = primary/live series); rejected: a multi-hue series palette (breaks the thread discipline v1.1 ratified). Thread stays line/live/warn only; `--accent` stays ink.
- **Eng**: re-copy colors.css delta verbatim (mist/stone/dusk + `--control`), extend the alias block (`--ok`), ThemeToggle port (menu, fade, `aria-checked`), pre-paint script extended: stored pick → else light, dark device → **dusk** (kit boot rule). **Storage migration**: legacy stored `"dark"` must map to `dusk` (the id set changes from light/dark to light/mist/stone/dusk — an unmigrated `dark` value would silently fall back to light). `theme-color` meta: Irori has none today (only favicon) — optional per-step meta or skip.

### 5. Token stats — own card, default 24h

- **PM**: the fleet landing page shows no token picture today (it lives in the Analytics lens since IRI-040); the owner wants a glanceable sparkDash-style card on Overview. Dedupe decision: the NAS card's "Tokens · {range}" block overlaps — keep or fold into the new card.
- **UI/UX**: dedicated Overview "Token stats" card built on v1.4 StatCard anatomy: label/figure/sub tiles — Total, Generated, Prompt, Cached, Cache hit, Cost (+ client-folded Output:input, Avg/hour, Busiest hour), delta vs previous period ("▲ 47% vs prev. 24 hours", per-stat from one prev-window fetch; cache-hit delta in points). **The card follows the topbar range control** (default 24h, persisted) — a second per-card chip row would put two range surfaces on one page; sparkDash's per-card chips map onto Irori's topbar control instead, and "Reset" has no stored state to clear (out of scope). Copy CSV stays optional (the `modelsCsv` precedent copies per-model rows, not a KPI summary — a KPI-summary CSV is new, small).
- **Eng**: zero new endpoints for the core: `GET /api/v1/analytics/tokens` returns `fleet {total,generated,prompt,cached,cacheHitPct}` + `costMinor` (analytics.ts:137-176); delta = second fetch with `offsetMs` (param exists, client math precedent AnalyticsView.vue:186-191); ratio/avg-h/busiest-hour folded client-side from `series` buckets. Optional server adds: `14d` and `all` range values (ANALYTICS_RANGES + bucket mapping; `all` needs ledger-bounds handling). Copy CSV: `modelsCsv` precedent (tokens-data.ts:108-118).

### 6. Fleet power default 24h

- **PM/UX**: 24h is the review lens for power/energy/cost; 30m is the live-freshness lens for heroes. Blanket-changing the shared range default to 24h would push 24h of history into hero sparklines — wrong for both.
- **Eng**: split the shared `range` ref into per-surface defaults (cards 24h via the topbar control; heroes fixed 30m history). Small refactor of OverviewView range plumbing + test pins; `refreshCards`/`refreshCharts` split already exists (:378-381).

## Proposed design

**Decision**: one epic, mockup-first (the bs-ds-v11-adoption flow; precedent IR-195 options mockup inside epic IR-194). S1 produces `mockups/v14-*.html` (shell collapsed + topbar controls, cleanup drawer restructure, token stats card, 4 themes, power defaults) verified in Chromium across the four themes and width sweep; owner approves the mockup before implementation stories run. ADR-0019 (supersedes ADR-0018) records the v1.4 source of truth and the Irori-owned extensions.

**Rejected alternatives**:
- *App-global range control driving every view* — rejected: Analytics/Usage own different option sets, URL-hash persistence and delta semantics (IRI-046 kept them per-view); a global control would either fight those or become a second source of truth. The topbar range is contextual (Overview) and persisted.
- *Centred modal for cleanup (kit Dialog 440px)* — rejected: the flow is a long job form with sticky typed-confirm; a drawer with body-scroll region keeps the established idiom and fixes the defect for all four entry points at once.
- *Multi-hue chart series palette (sparkDash-style)* — rejected: breaks the ratified thread discipline (one held colour per screen); data-positive colour enters via `--ok` on stat deltas instead.
- *Hand-tuned oklch for the two new themes or mist/stone "simplified" variants* — rejected: verbatim copy is the ADR-0005/0018 mechanism; hand-tuning recreates drift.
- *Replacing the token ledger with the capture stream for the stats card* — rejected: the ledger covers engines without proxy capture (IRI-054); the card reads the same `/analytics/tokens` fleet aggregate the lens already uses, so the two stay reconcilable.

## Phased delivery plan (epic + stories, order = dependency)

**Epic — "DS v1.4 adoption + shell controls round (UI feedback round 8)"**
Goal: Irori renders on DS v1.4 (four themes, `--control`, theme menu) with a collapsible sidebar, topbar time-span + Add node CTA, a non-scrolling cleanup drawer with a UX pass, a sparkDash-inspired token stats card (default 24h), and fleet power defaulting to 24h.

1. **S1 — Mockup round v1.4** (`mockups/v14-overview.html`, `v14-serve.html`, `v14-models.html` + shell/drawer scenes; `mockups/PLAN.md` round record). AC: all six asks depicted; four themes × light/dark-device boot (each stored step under OS dark mode); collapsed rail **with icon assets decided** (sourcing + whether the expanded sidebar also gains icons); topbar controls at 320→1568, no overflow, 0 console errors; cleanup drawer shown pre/post-restructure; browser-verified.
2. **S2 — ADR-0019** (supersedes ADR-0018): v1.4 source of truth, four-step scale + boot rule (dark device → dusk), `--control`, Irori-owned extensions (collapse + icon sourcing, topbar controls, drawer body-scroll rule, StatCard usage), storage migration (`dark`→`dusk`). Procedural note: ADR-0018's literal revisit trigger ("v1.2 with token renames") does not fire — v1.4 is additive; the supersession is because a new kit version requires a regeneration pass over the token blocks and the ADR records a new decision. AC: ADR indexed, docs-check green.
3. **S3 — Tokens + theme runtime**: colors.css verbatim re-copy (+mist/stone/dusk, `--control`), ThemeToggle menu port (replaces `.bs-theme`), pre-paint script, legacy-value migration, 4-theme verification sweep across all routes. Copy mechanics the review pinned: (a) **retire the `@media (prefers-color-scheme: dark)` auto-dark block** (irori.css:35-46 — `:root:not([data-theme="light"])` has specificity (0,2,0) and re-declares all base tokens, so it beats any (0,1,0) `[data-theme="mist"|"stone"|"dusk"]` scope regardless of file order; dark-OS + stored mist renders the v1.1 dark palette) — owner pick: delete it (the boot script always sets `data-theme`); (b) **add `--control` to the surviving dark scopes** (Irori's two dark blocks don't have it; v1.4's dark scope does); (c) **alias-block ordering**: the deliberate `--accent: var(--ink)` override (irori.css:84) ties at (0,1,0) with the copied scopes — it must be re-declared inside every theme scope (or the alias block kept provably last) or mist/stone/dusk silently get thread accents; (d) **do not copy the v1.4 `[data-theme="dark"]` block** — it is artboards-only (kit readme) and would turn an unmigrated stored `dark` into a near-black artboard palette. Owner decision: no new colour roles (`--ok` out of scope; `--success` aliases stay as-is). AC: every route renders on four steps — including each stored step booted under OS dark mode — pick survives reload, no FOUC, reduced-motion skips fade, legacy `dark` maps to `dusk` (test the real failure: without migration, stored `dark` must not render the artboard palette), contract tests updated.
4. **S4 — Shell: collapse + topbar controls**: persisted collapsed rail (≥901), topbar range control + `irori.range` store (S4 owns the control and the store; S6 consumes them), **Add node as a ghost/secondary chip** in the topbar opening NodeModal from any route (owner pick — page CTAs like Serve's "New setup…" stay as they are); Overview pagehead duplicate removed; small-tier handling per mockup. The rail needs **~10 icon assets the app doesn't have** (nav is label+count text only, App.vue:171-182; no `.bs-icon` pattern exists in irori.css) — source them as local masked SVGs vendored from the kit's `assets/icons/lucide/`; the kit's `Icon.jsx` masks a jsDelivr CDN at runtime, which the air-gapped LAN hub cannot take. AC: collapse persists across reloads; a11y (aria-expanded, icon labels, focus); count bubbles; test pins; docs/CONFIGURATION.md updated.
5. **S5 — Cleanup drawer restructure**: fixed header + body scroll region + sticky confirm; accordions for secondary sections; `v-dialog` + `aria-modal`. The shared `.drawer` chrome has **eight instances across six components** (CleanupDrawer.vue:294, ServeView.vue:1023, UsageView.vue:675 and :735, NodeDetail.vue:1466, ModelsView.vue:1431/:1521/:1583); every one must get the `__body` wrapper or it loses scrolling entirely (fixed-height flex column with no scroll region). Reuse the existing unused `.drawer__body` hook (irori.css:494). Also reconcile the **pre-existing ≤720 `visibility` gate** (irori.css:486-487: `body .drawer { visibility: hidden }` / `.is-open { visible }`) — five of the eight instances never render `is-open` and are statically invisible on phones today (chrome-markup.test.ts:42/:84 pins the contract for only the two that do). NodeModal/HubSettingsModal use their own `.modal__panel` and are unaffected. AC: no `.drawer` instance regains or loses scroll; all eight visible and scrollable ≤720 (or the visibility contract deliberately fixed); the cleanup panel never scrolls at any viewport; Escape/focus parity with ServeView drawers; job flow unchanged; chrome-markup.test.ts verbatim rule pin (:100-105) rewritten with the new chrome.
6. **S6 — Overview default 24h + range plumbing**: consume the S4 `irori.range` store and flip the default 30m→**24h** for the whole page — owner pick: **heroes follow the topbar range too** (one persisted range again; the IR-128 "one range, two surfaces" contract moves to the topbar rather than being removed; overview.test.ts:283/:318-323 pins rewritten for the new store, not deleted). One mechanic the review pinned stands: **"Fleet now" and the per-node barrows are *now* surfaces derived from the same range-fetched series** (OverviewView.vue:298 → :620-626/:629-634, refresh-note :415-419) — at 24h the hub returns *hour* buckets (analytics.ts:50-53, avg per bucket), so the new default would make "Fleet now" an hour-stale average; source them from a separate always-fresh fetch (30m power series) or `live.snapshots`, independent of the range. AC: after a fresh load the page defaults to 24h; "Fleet now"/barrows stay minute-fresh at every range; changing the topbar control refetches cards and heroes; range survives reload; pins updated.
7. **S7 — Token stats card**: Overview StatCard-based KPI card (Total/Generated/Prompt/Cached/Cache hit/Cost + Output:input, Avg/hour, Busiest hour folded), range = the topbar control (default 24h via the S4/S6 store — no per-card chips), **per-stat deltas from one prev-window fetch** (`offsetMs`; the current precedent threads one `deltaPct` into Total only, tokens-data.ts:79-84) plus cache-hit delta in points; **granularity-aware Busiest hour** (argmax over the returned buckets; at 30d/90d the hub returns day buckets — analytics.ts:45-56 — so relabel to "busiest day" or hide); dedupe of the NAS token block per the mockup; Copy CSV optional and explicitly a new KPI-summary CSV (modelsCsv is per-model rows, tokens-data.ts:103-118). **Scope change to document**: the server `fleet` aggregate sums every node with ledger rows (analytics.ts:141-156) while today's NAS-card fold is spark-only (`tokenTotals(rawTokens, sparkIds)`, OverviewView.vue:233) — switching to `fleet` is lens-parity (recommended) but changes displayed totals the day a non-spark node writes rows; state it in the story, don't let it drift. AC: numbers reconcile with the Analytics tokens lens at the same range; per-stat deltas match the prev-window fetch; empty-fleet + all-null states; fold tests name which tiles carry deltas (`tokens-data.test.ts` pins `fleetTiles`).
8. **S8 — Closeout and final verification**: owner declined new ranges (keep 30m→30d; 14d/All-time revisit when a use appears — the review's sizing notes stay in this doc for that day: `all` ships without ▲-vs-prev deltas and needs per-lens bounds handling). Closeout: CHANGELOG, docs sweep (docs/CONFIGURATION.md for the topbar controls + collapse), final 4-theme × width verification, epic evidence comment. AC: validate + docs-check + `pnpm test`/`build` green.

**Test pins to rewrite (enumerated by review)**: chrome-markup.test.ts (verbatim `.drawer` rule :100-105, `is-open` visibility contract :40-45/:84, hamburger + 44px topbar floors incl. the `.bs-theme` button :157-174), ds-markup.test.ts:33 (`irori-theme`) and :77-85 (`.shell` grid string — S4's collapsed variant), overview.test.ts:283/:318-323 (shared-range contract — S6), cleanup-drawer-ir84.test.ts + cleanup-harness.ts (drawer DOM — S5), tokens-data.test.ts (`fleetTiles` — S7).

S1 → S2 → S3 first; S4 owns the range control + `irori.range` store, S6 consumes it and flips defaults, S7 consumes it for the token card (so S4 → S6 → S7 order; not parallel as first drafted); S5 is independent of S4/S6/S7; S3 gates all UI stories.

## Risks & open questions

*(Resolved at the gate 2026-11-13 — see Gate decisions above: create/backlog, card follows topbar, heroes follow topbar, ghost Add node, colour = DS in place, bounded body scroll, no new ranges. Remaining open items are mockup-level (S1 decides): collapse shape details, expanded-sidebar icons, small-tier Add node home, NAS-block fold placement, delta accent within DS tokens.)*

1. **Sprint placement**: IR Sprint 4 (1004) ends 2026-11-15 — this epic does not fit; backlog or IR Sprint 5 at the gate?
2. **Collapse shape**: icon rail width (~68px), count bubbles vs hidden counts, foot content when collapsed — mockup decides; confirm the direction (recommend: icon rail, persisted, bubbles). Sub-decision: **icon sourcing** — ~10 nav icons don't exist in the app; vendored local lucide SVGs (no CDN — the hub is LAN-only), and whether the expanded sidebar gains icons too.
3. **Topbar range scope**: Overview-only (contextual, recommended) vs all data views. The token card follows this control either way (no per-card chips — resolved after review). Option set: keep 30m→30d (+14d?) — sparkDash's "All time" maps to 90d max today.
4. **Add node CTA style**: filled in the topbar (chrome's one filled button) vs ghost chip; the only pagehead filled primary is Serve's "New setup…" (ServeView.vue:909) — demote it or keep the topbar CTA ghost; small-tier home (icon-only vs hamburger).
5. **Token stats dedupe**: new Overview card + keep the NAS-card token block, or fold the block into the new card (recommend fold — one token surface per page). KPI set confirmation (the 6+3 tiles with per-stat deltas).
6. **Hero history window**: pinning heroes to 30m removes the user's ability to widen hero sparklines that the shared seg provides today (watch(range) refetches heroes, OverviewView.vue:377-381). Accept the loss (recommend — heroes are the live-freshness lens; 24h history lives in the node detail) or have heroes follow the topbar range too?
7. **Cleanup drawer reading of "can't happen"**: fixed chrome + sticky typed-confirm + bounded body scroll (recommended — long audit lists still scroll internally) vs kit-Dialog content-must-fit (default view collapses everything; nothing scrolls). Confirm.
8. **Colour depth**: `--ok` data colour + four themes confirmed; light-theme green needs a contrast-checked value (mockup verifies per theme). Chart series stay neutral+thread. Does the owner also want warn/amber-style data accents on the token card (sparkDash-style busiest-hour highlight), or is green-deltas + four themes the full extent of "multiple colours"?
9. **Legacy theme migration**: stored `"dark"` → `"dusk"` mapping must ship with S3 — and the v1.4 artboards-only `[data-theme="dark"]` block must **not** be copied, or an unmigrated `dark` silently renders the near-black artboard palette.
10. **S3 dark handling**: delete the auto-dark media query outright (boot script always sets `data-theme`) vs keep a `:root:not([data-theme])` no-JS fallback (recommend delete — simplest, and JS-set attributes are guaranteed by the boot script).
11. **Power freshness**: approve a separate always-fresh source for "Fleet now"/barrows (30m series or `live.snapshots`) inside the 24h power card (recommend: one extra 30m power fetch per 60s poll — the Analytics lens already fires 5 parallel requests per change).
12. **"All time"**: approve knowing it ships **without ▲-vs-prev deltas** (no shifted window) and needs bounds handling in efficiency/reconciliation too — or drop `all` and ship `14d` only (recommend `14d` first, `all` when a use appears).

## Jira overlap findings (project IR, live search 2026-11-13)

- **Exactly one open issue**: IR-200 [Epic, To Do] "Disk-pressure and degraded-database visibility with operator CTAs" — hub filesystem/database monitoring + health SSE + operator CTAs. **Relation, not duplicate**: it will render operator CTAs against health findings; the cleanup-drawer restructure (S5) is the drawer those CTAs may reuse → **Relates** link at creation. No scope collision found (its deliverables are hub-disk metric, DB availability, degraded-state UX).
- Prior art (all Done), link-not-duplicate: IR-214/215-223 (DS v1.1 skin — this epic extends to v1.4), IR-217 (shell — collapse + topbar extend it), IR-194/195/197/198 (mobile shell + clock placement — small-tier handling builds on it), IR-180 (round 6), IR-165 (usage cost layer), IR-42/IR-51 (usage capture), IR-204/207/211 (disk banner CTA, bulk store cleanup, staging prune — the drawer's job kinds), IR-128 (tier machinery + range select), IR-97 (power histogram tooltip), IR-152 (serve UX), IR-160 (health rules).
- `text ~ "collapse"`, `"colour"`, `"time span"`, `"token stats"` return no open items — no duplicates possible.

## Expert review record (2026-11-13, pre-gate)

Two read-only adversarial reviewers ran against the draft (transcripts: `history://PmUxReview`, `history://EngReview`); 24 findings, all dispositioned into the plan above. The load-bearing ones: the retained auto-dark media query would structurally defeat mist/stone/dusk on dark-OS devices (now S3-a, was BLOCKER); the token-card-vs-topbar double range control (resolved: card follows the topbar); the `.drawer` blast radius enumerated to eight instances plus the pre-existing ≤720 `is-open` invisibility bug (S5); "Fleet now"/barrows going hour-stale under a 24h card range (S6-a, separate always-fresh source); the collapsed rail's hidden icon cost — ~10 assets, no CDN (S4, vendored lucide SVGs); per-stat deltas + granularity-aware Busiest hour (S7); alias-block ordering and the artboards-only dark block (S3-c/d). Both reviewers independently confirmed the evidence base (no stale file:line claims) and that all six owner asks are covered end-to-end.

## Deliberately out of scope

- Any IA/route changes (transfers surface IRI-048 decision still open), the mobile tab-bar kit part, sparkDash parity for cost metrics beyond what exists, force-dark log console changes, and re-skinning screens already swept by IR-223 (v1.4 is token-additive; S3's sweep covers them).
