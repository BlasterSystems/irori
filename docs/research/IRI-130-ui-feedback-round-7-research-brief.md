# IRI-130 research brief — UI feedback round 7: mobile horizontal overflow, top/bottom nav + footer, fleet clock placement

Owner feedback 2026-11-06 against the live DEV build `dev-0.6.0-2` (main `18082c6`, verified via `GET /api/v1/version` on 10.20.30.9:3947):

1. "there are a few issues with horizontal scrolling"
2. "there are a few issues with top and bottom nav on mobile view (buttons, footer height, etc)"
3. "Fleet clock section isn't the most important thing, use UI/UX expert to better define its location"

**Screenshot caveat.** The three attachments are identical and show a store-pickup flow ("Retiro en tienda", Kuna Foods) that does not exist in this repo (`grep -ri "retiro|vitacura|kuna|camila"` → 0 matches). The three feedback points are coherent as Irori web feedback and are treated as such; the owner should re-share the intended screenshots if they carried specific defect locations. Raised again at the validation gate.

## Jira target

| Coordinate | Value | How resolved |
|---|---|---|
| Project key | `IR` | Repo artifacts (docs/research/IRI-124 brief "Jira overlap findings (project IR)", `tasks/IRI-*.md` ↔ IR keys, commit subjects `… (IR-193)`) + managed skill `mwa-jira-rest` Site 3; **no explicit user instruction this session** |
| Site host | `https://blastersystems.atlassian.net` | `mwa-jira-rest` Site 3 credential map (pair `JIRA_EMAIL_BLASTERSYSTEMS`/`JIRA_API_TOKEN_BLASTERSYSTEMS`) |
| Board id | **5** ("IR board", type simple) | Live `GET /rest/agile/1.0/board` filtered on projectKey=IR, 2026-11-06 |
| Issuetype ids | Epic **10021**, Story **10022**, Bug **10023**, Task **10024**, Subtask **10020** | Live createmeta `?projectKeys=IR&expand=projects.issuetypes`, 2026-11-06 |
| Active sprint | **998 "IR Sprint 3"** (2026-11-02 → 2026-11-09) | Live `GET /rest/agile/1.0/board/5/sprint?state=active`, 2026-11-06 (supersedes the stale sprint-990 note in project memory) |
| Assignee | `<redacted-jira-account-id>` (Bruno Pires) | Live `/rest/api/3/myself` |

Per repo rule and the research skill: **no Jira write happens without explicit owner approval in-conversation** (human gate). Conventions that will apply at creation: comments/descriptions plain-text mark-free, no `+` characters, backtick identifiers, issue-key-like tokens reworded, epics unlabeled, children `Task`, priority Medium, all added to sprint 998 including the epic (epic sprint-membership not listed on simple boards — verify per-key instead).

## Summary of the ask

Three web-only UX defects/improvements, no DB or API changes expected:

- **US1 — horizontal scrolling.** Primary suspect identified: AnalyticsView's three `.tbl` tables use a class with **no CSS definition anywhere** and no scroll wrapper, so 7-column tables with long model names force page-level horizontal scroll on phones; ModelsView tables and a few nowrap values add to the class. **Owner screenshots (2026-11-07) also show the Overview page itself scrolling horizontally at ~367 px** — an additional culprit to be found by tree-bisect. The brief prescribes a measured sweep (320/390/480/720, all 11 routes) plus the app's existing flush-wrapper pattern instead of ad-hoc patches.
- **US2 — mobile top/bottom nav + footer.** There is **no bottom tab bar**: the mobile nav is the hamburger disclosure dropdown, and the "bottom nav" is the sticky footer (version line + Transfers/Telemetry buttons). The complaints map to: topbar controls crowding/wrapping at ≤720 with only the hamburger pinned at 44px, and the footer's height/safe-area/typography stack on phones — **screenshots confirm the footer stacks Transfers/Telemetry vertically beside the wrapped version line, a tall overlay**. Fix per approved mockup.
- **US3 — fleet clock section placement.** The fleet clock/clock-cap section (IR-189 deliverable) is over-prominent for its importance. Owner explicitly asked for a UI/UX expert pass → mockup options round (`irori-mockup-iteration`, IRI-043/IRI-048 options-page precedent) with designer + PM static reviewers, owner picks, then port.

## Current state (evidence)

### 5.1 Mobile shell: topbar + footer (US2 target)

**Single shell.** `apps/web/src/App.vue` owns everything: `<header class="topbar">` 130–172, `<main class="container page">` 174–186 (a v-if view chain — there is no `<router-view>`; the custom hash router `apps/web/src/router.ts:10–49` mounts one of 11 views), `<footer class="foot">` 188–196, modals/docks 198–201.

**Topbar on mobile.** The inline desktop nav renders only above 1440px (`<nav v-if="tier === 'full'">` App.vue:136; tiers small ≤900 / medium 901–1440 / full >1440, `apps/web/src/tiers.ts:17–19`). Below full, nav is a **hamburger disclosure dropdown**: `navtoggle` App.vue:156–158, `.navmenu` absolute right-anchored panel `:159–170` (CSS `iroiri.css:149–155`), closed by Escape/outside-pointerdown/route-or-tier-change (`:44–70`). **10 nav items**, identical order in both surfaces (App.vue:137–146 / 160–169): Overview, Models, Serve, Analytics, Usage, Chats, Benchmarks, Audit, Logs, Community. Header controls after the brand (App.vue:132–135): offline warn chip (`v-if="!connected"` :148), theme toggle iconbtn :149–152, hub-settings gear :153–155, hamburger :156–158. At ≤720 the topbar becomes `height: auto; flex-wrap` (`iroiri.css:328–329`) while `.topbar .chip, .topbar .iconbtn { flex: none }` (:331) keeps controls unwrappable — content pushes them to a second row; **only the hamburger has a pinned 44px hit target** (App.vue:212–213, iroiri.css:354); theme/gear inherit the default iconbtn size. Topbar is sticky, 64px `--topbar-h`, translucent blur (iroiri.css:57, 117–119).

**Footer (the "bottom nav").** `<footer class="foot">` App.vue:188–196: left = mono line `Irori {version} · {tag} · updates every Ns · {watts}` (:190); right = `Transfers` button with live count bubble (:192, IR-131) and `Telemetry` button (:193). It is `position: sticky; bottom: 0; z-index: 5` (iroiri.css:85–87), pinned by the `#app` 100vh/100dvh flex shell (:64–66); `.foot__in` min-height 38px (:88); mobile `min-height: 40px; padding-bottom: env(safe-area-inset-bottom)` (:338); small tier adds `padding: 8px 12px; font-size: 10.5px; margin-top: var(--space-3)` (App.vue:210–211). **There is no bottom tab bar** — the owner's "bottom nav" can only be this sticky footer (its two buttons + height/safe-area stack on phones).

**Breakpoint two-system mismatch (decision needed).** JS `data-tier` "small" starts at ≤900 (`tiers.ts:17–19`), but the global compact-reflow block is `@media (max-width: 720px)` (iroiri.css:327–381; 480px block :382–386). The **721–900 band** gets small-tier JS rules (12px gutters, `iroiri.css:157`; App.vue:207) but **not** the mobile reflow; components paper over it individually at ≤900 (ChatsView.vue:199, AuditView.vue:319) while most use ≤720 [INFERENCE: historical, not designed].

**Shell test pins.** `chrome-markup.test.ts:96–115` pins the hamburger disclosure chain (v-if tier, `aria-expanded`, `#navMenu`, Escape focus return, `.navmenu` CSS, 12px gutters) and the footer Transfers CTA + `.countbub`; `ds-markup.test.ts:32–45, 87–95` pins topbar lockup classes, offline chip, gear, and the footer sticky rules **verbatim against iroiri.css**. No happy-dom mount of App.vue exists [INFERENCE: none in test/].

### 5.2 Fleet clock section (US3 target)

**Placement is the defect.** `apps/web/src/components/OverviewView.vue:542-576` renders a "Fleet clock caps" `<section class="card section-gap">` as the **2nd section on Overview** — after Fleet temperatures (`:518-540`, small-tier-only via `:786-787`) and **before** the serving hero cards (`:579-586`), Nodes (`:609-615`), Power (`:618-686`), Updates (`:687-708`), Telemetry feed (`:709-715`). Pagehead `:502-516`. On a phone this pushes the fleet's primary content (serving heroes, node cards) below a rarely-used maintenance control — exactly the owner's "isn't the most important thing". The owner's 2026-11-07 capture at ~784 px confirms the card sits directly under the pagehead, above the serving hero.

**Structure / behavior.**
- Always rendered — no `v-if`, no disclosure (`:542`); renders even with **0 spark nodes**, violating the IRI-025 "hide what has no data, never leave dead space" rule (hero cards do it right: `v-if` at `:580`).
- Header: h3 + Tip tooltip (ceiling-not-operating-point, oneshot, re-assert-on-online) `:544`; right count `{{ sparkNodes.length }} spark nodes` `:545` (`sparkNodes` = all non-NAS nodes, `:47-48`).
- Controls row `:548-564`: GPU preset select `#fleetGpuCap` (default "GPU: leave alone") `:549-553`; CPU preset select `#fleetCpuCap` `:554-558`; "keep after reboot" checkbox `:559-561`; "Apply to fleet" secondary `:562`; "Clear fleet" ghost `:563`.
- Per-node outcomes are inline **result chips** `:567-574` (`chip--ok` ✓ / `chip--warn` ✕) with the per-side detail only in the `title` attribute (`:571-572`) — invisible on touch; `fleetMsg` `:565`, `fleetError` `:566`.
- `applyFleetCaps(clear)` `:70-91` → `setFleetClockCap` (`apps/web/src/api.ts:235-253`) → `POST /api/v1/clock-cap` (`apps/server/src/app.ts:1471-1512`: targets `kind==="spark" && enabled` `:1499`, sequential `applyClockCaps` `:1502-1505`, **200 all / 207 partial / 502 none** `:1506-1508`, audit `fleet.clock-cap.post` `:1475`), then `live.refreshNodes()`.

**Drift visibility.** The `clock_cap_drift` rule (`packages/core/src/health.ts:18-25,108-109`: streak `gte 4` ≈ 2 min of 30 s sweeps, warn, 1800 s cooldown; evaluated per sweep `apps/server/src/health.ts:352-364`) surfaces **only** as warn chips in the NodeDetail header (`apps/web/src/components/NodeDetail.vue:935-940`, findings watch `:445-452`, `fetchHealthFindings` `api.ts:486-494`). No fleet-level drift signal exists; the Overview section shows none.

**Node-level clocks (NOT part of the complaint — relocation must not touch them).** Cap controls live inside the History CPU card (`NodeDetail.vue:1268-1285`, `cpuSupported` fallback copy `:1286-1287`, effective per-policy line `:1288`) and GPU card (`:1335-1349`, presets + "(current)" non-preset option via `gpuCapOptions` `:311`, `apps/web/src/detail-data.ts:22-35`; presets `detail-data.ts:7-12` — GPU 1800/2000/2200/3000, CPU 1400/2000/2800). Per-node PUT `app.ts:1414-1466`; `GET /clocks` `:1281-1297`; hub `apps/server/src/hub.ts:558-591`; re-assert `apps/server/src/clock-caps.ts:35-76` wired `index.ts:289-303` + `hub.ts:111-115` (IR-189).

**Demotion patterns already in the app** (option space for the mockup round):
- Show/Hide toggle + lazy load: `AuditView.vue:189-191,120-123`; per-row expand `:125-127,204-205`.
- `<details>/<summary>`: `ChatsView.vue:179-181`.
- Scrim drawers: `CleanupDrawer.vue:193-195`; `ServeView.vue:995-996,1068-1069`; `NodeDetail.vue:1463-1464` (job sheet); `UsageView.vue:673-674`; shared chrome `apps/web/src/assets/irori.css:251-255`; nested-dialog stack `apps/web/src/dialog.ts:10-13`.
- Footer-CTA side drawer: `TelemetryDrawer.vue:75-77` opened from `App.vue:84-85`.
- Modals: `OverviewView.vue:721` (NodeModal / HubSettingsModal). Tabs: `UsageView.vue:80-83,442-443`.
- Tier-CSS hiding + burger nav below full tier: `App.vue:52-56,156-159`.
- Data-driven hiding (IRI-025): `OverviewView.vue:401`, heroes `v-if` `:580`.

**Tests.** No web test covers the fleet section — `grep 'Fleet clock caps|applyFleetCaps|fleetGpuCap|fleetResults|setFleetClockCap'` in `apps/web/test` → 0 hits; `overview-shaped-ir84.test.ts:56-72` mounts OverviewView without fleet-cap assertions [INFERENCE from exhaustive grep]. Server side is covered: `clock-caps-ir189.test.ts:149-247` (200/207/502/400), `health-ir69.test.ts:230-294` (drift streak), `power-ir68.test.ts:132-205`.

### 5.3 Horizontal overflow inventory (US1 target)

**Owner screenshot confirmation (2026-11-07).** Three captures of the live DEV Overview settle the diagnosis:
- **Phone (~367 px, dark):** the page is scrolled **horizontally** — the brand lockup ("…vori"), node names ("…2" for DGX-2), and row labels ("FLEET NOW" → "NOW", "179 W" → "…W", ":8082 idle" clipped) are cut off at the left edge, and the sticky topbar scrolled away with the page. **Overview itself contains an uncontained element** at phone widths — the S1 tree-bisect must start there. Candidates to measure (not guess): the small-tier 3-col statgrid with nowrap `.stat__value` lines, the fleet-draw histogram, pagehead/hero meta lines.
- **Same capture, footer:** `Transfers` and `Telemetry` stack vertically beside the wrapped version line → a ~3-row footer overlaying content while scrolling (sticky, z-index 5) — the "footer height" complaint, confirmed.
- **~784 px (the 721–900 band, hamburger visible):** the "Fleet clock caps" card sits directly under the pagehead and above the serving hero (GPU/CPU selects, keep-after-reboot, disabled Apply to fleet, Clear fleet) — the US3 prominence complaint, confirmed.

**No global guard.** Nothing sets `overflow-x` on html/body/#app (iroiri.css:62–66); `.cols > * { min-width: 0 }` (:94) and the `.cols-*` collapse at ≤1080 (:317–318) are the only global help. Container 1200px / 24px padding (:76); 12px gutters on small tier (:157).

**The reusable fix pattern already exists.** `@media (max-width: 720px)`: `.card__body--flush { overflow-x: auto; -webkit-overflow-scrolling: touch }` + `.card__body--flush .table { min-width: 640px }` + sticky first column (iroiri.css:366–369). Consumers: UsageView 418/461/502/531/561/607/630, OverviewView 693–694, AuditView 201/250, LogsView 189, ChatsView 123. All-widths inline variant: BenchmarksView 402, 459. Internal scroll already contains logs/drawers (`.log` :242, `.drawer` :253, `.model-scroll` NodeDetail 1556–1558, `.wizard` ServeView 1337–1340).

**Defects found (ranked).**
1. **AnalyticsView `.tbl` tables — the likely owner-reported scroll.** Three tables (`:316` by-group, `:337` by-model with 7 columns, `:397` engine divergence with 7 columns) use a `.tbl` class that has **no CSS definition anywhere** (AnalyticsView's scoped style is only `.capitalize` :419–421; `.tbl` is absent from iroiri.css) and sit in padded `.card__body` with no wrapper, no min-width, no overflow-x → long model names + 7 columns force **page-level horizontal scroll** on phones [INFERENCE on severity: `table-layout: auto` keeps content width].
2. **ModelsView main table unwrapped**: `.table` directly in page flow (:944, no flush wrapper); queue :994, node-state :1042, bulk-add :1188 similar [INFERENCE: columns mostly wrap, but unbreakable repo ids are unhandled].
3. **`.stat__value { white-space: nowrap }` without ellipsis** (iroiri.css:203): long token counts can overflow small-tier 2-col statgrid cells (OverviewView 823–824); only `.stat__sub` gets nowrap+ellipsis ≤720 (:347, OverviewView 828) [INFERENCE: content-dependent].
4. **Fixed 320px cap**: NodeDetail.vue:1385 path ellipsis `max-width: 320px` — wider than the column on 320–390px phones.
5. **`.kv` dd without `overflow-wrap: anywhere`**: handled in ServeView 1033/1120/1238–1239/1302–1303 and LlmPanel 77–80; any dd without it (e.g. HubSettingsModal env values) is a long-token risk [INFERENCE per instance].
6. **Inert rule**: `body .stage { grid-template-columns: 1fr auto }` ≤720 (iroiri.css:376) has no `display: grid` to act on (ServeView defines only `.stages` :1319) — dead CSS hiding an unfinished intent [INFERENCE].
7. Cosmetic: UsageView error-signature cell `max-width: 420px; nowrap; ellipsis` (:540) — contained by the flush wrapper but the 420px cap exceeds a 375px viewport.

**Verified safe:** ChatsView (single column ≤900 :199–203, pre-wrap break-word, tool-call `pre.log` internal scroll), AuditView (div rows, ellipsis summary, `pre.log` internal scroll, 1fr ≤900 :314–322), Benchmarks (wrapped), all drawers/modals (`width: min(Npx, 100%)` + 100% ≤720: TelemetryDrawer 139–142, TransfersDock 255–258, HubSettingsModal 303–304/329–332, NodeModal 227–228), log viewers (line span `flex: 1; min-width: 0; pre-wrap; break-word` LogsView 251–256; Overview feed `.log` internal), setup wizard (`.pick-grid`/`.env-grid` 1-col ≤720 ServeView 1444–1455; `.steps` nowrap + overflow-x ≤720 iroiri.css:363; radio model rows wrap `anywhere` ServeView 1120).

**Routes (the sweep denominator).** Custom hash router, vue-router deliberately unused (router.ts:1–3; parseHash :10–49): overview (fallback), models, serve (+`recipeJob` deep link), community, benchmarks, analytics, usage, chats, audit, logs, `node/:id`. All 11 views statically imported (App.vue:4–16, 175–185).

**Test harness facts (constrain S1/S3).** View mount suites exist per view (view-batch-ir84, views-ir84, big-views-ir84, small-components-ir84 + shaped suites; `node-detail-clocks-ir124.test.ts` mounts real NodeDetail). Harness: `vi.mock("../src/live")` + `vi.mock("../src/scrim")` (view-batch-ir84.test.ts:22–23), per-path fetch stubs (:14–20), 80–150 ms settle before asserts. The IR-175 ratchet is a manually raised coverage gate: `apps/web/package.json:11` `--coverage.thresholds.lines=57`, `vitest.config.ts:10–16` (`all: true, include: ["src/**"]` — unloaded files count 0%, number monotonic), `scripts/cov-missed.ts` prints missed lines per view for targeting. New view code must land with tests or the gate blocks.

## Gap analysis

No DB or API changes are needed for any of the three points — this is a web-only round (server-side clock endpoints already behave per IR-189).

| Owner point | Current state | Gap |
|---|---|---|
| US1 horizontal scroll | `.tbl` has no CSS/wrapper at all (AnalyticsView ×3); ModelsView tables unwrapped; `.stat__value` nowrap; fixed 320px cap; no global overflow guard | A *class* of uncontained wide content. The app already owns the flush-wrapper idiom — it just isn't applied everywhere. Need a measured sweep + pattern application, not new UI. |
| US2 top/bottom nav | Topbar: 4 controls, only hamburger pinned at 44px, auto-height wrap ≤720. Footer: sticky, 40px + safe-area, 10.5px font, 2 buttons | Tap-target/height/spacing polish is a design decision (→ mockup), plus the 721–900 breakpoint-band question. |
| US3 fleet clock | 2nd section on Overview above serving heroes/Nodes; always expanded; renders when empty; per-node outcomes title-only; no fleet-level drift signal; zero web tests | Relocation decision (→ mockup) + hide-when-empty + touch-legible outcomes + drift reachability + first mount test for the section. |

## Proposed design

Decision frame (evidence lands in Current state):

1. **US1 is a sweep, not a per-view whack-a-mole.** Use the mockup-era measurement recipe against the real app: `documentElement.scrollWidth > innerWidth` at 320/390/480/720/721/900/1024/1568 per route, tree-bisect the culprit (hide `body > *` recursively), then fix with the app's own wrap/scroll idiom. The primary suspect is already identified — AnalyticsView's undefined `.tbl` (§5.3 #1) — plus the ModelsView unwrapped tables; the sweep exists to close the *class*, not just the named instances. Known latent traps from mockup rounds: grid `minmax(…px)` minimums summing past narrow viewports → wrap the scroller (`overflow-x: auto`) rather than chasing column minimums; hidden-but-laid-out tooltip boxes inflating `scrollWidth` (`opacity: 0`) → `display: none` when closed.
2. **US2 + US3 go through one options mockup before code.** Owner explicitly requested expert involvement for US3; the shell (topbar buttons, footer height) is cheap to include in the same options page. Precedent: `mockups/IRI-043-overlay-options.html`, `mockups/IRI-048-transfer-surfaces.html` — scenes side by side, each with scenehead/stage/scenenote; recorded in `mockups/PLAN.md`; option pages are NOT added to the curated gallery `mockups/index.html`.
3. **Clock relocation keeps IR-189 semantics.** Fleet apply (200 all / 207 partial / 502 none), drift streak visibility, and per-node caps must stay reachable wherever the section lands; relocation is presentation-only, no endpoint changes.

Rejected alternatives:

- **Fixing overflow per report** without a measured sweep: the owner said "a few issues" without locations; a sweep is the only way to close the class of bug, and the tree-bisect method exists precisely because eyeballing misses descendant-inflated `scrollWidth`.
- **Pre-deciding the clock section's new home in this brief:** contradicts the owner's explicit "use UI/UX expert"; the brief's job is to define the option space and constraints, the mockup round decides.
- **A global bottom tab bar on phone** (native-app pattern): an IA change the owner has not asked for; Irori's IA is single-homed by owner preference (reuse existing sections, no parallel surfaces). Can appear as a mockup option only if the expert recommends it — not pre-built into the app.

## Phased delivery plan

**Epic:** [IR-194] UI feedback round 7 — mobile horizontal overflow, top/bottom nav + footer, fleet clock placement. (Epic stays open through close-out, IR-78 precedent.)

| # | Key | Story (Task, 10024) | Area | Depends on | Acceptance criteria |
|---|---|---|---|---|---|
| S0 | IR-195 | Options mockup: mobile shell (topbar buttons, footer) + fleet clock placement scenes | mockups | — | Options page (IRI-043/048 idiom, phone frames at 320/390) with: (a) topbar scenes — control tap floors (theme/gear currently unpinned), wrap behavior with the offline chip present, footer height/typography/safe-area variants; (b) the 721–900 breakpoint-band decision (consolidate CSS mobile block with `data-tier` small, or keep); (c) clock-placement scenes — at minimum (A) demote below Nodes/Power, (B) drawer/modal from a pagehead affordance, (C) fold into the Updates card area — each applying the no-spark-nodes hide rule; light/dark, width sweep 320→1568 clean, zero console errors, designer+PM static review round applied, recorded in mockups/PLAN.md, owner picks |
| S1 | IR-196 | Horizontal overflow sweep fix across all 11 routes | web CSS/templates | — | `.tbl` gets a real definition or is replaced by the flush-wrapper pattern in AnalyticsView (3 tables); ModelsView tables contained; `.stat__value` gets an ellipsis/min-width guard; NodeDetail:1385 `max-width: 320px` → `min(320px, 100%)`; inert `.stage` rule fixed or deleted; `documentElement.scrollWidth ≤ innerWidth` on every route at 320/390/480/720 px light+dark; **the Overview culprit from the owner screenshots (page scrolled right at ~367 px, brand/node names/labels clipped) is identified by tree-bisect and fixed**; no nested scrollbars where wrap suffices; regression mount/markup tests for touched components |
| S2 | IR-197 | Mobile topbar buttons + footer per approved mockup | web | S0 | 44px touch floors on all topbar interactive controls (not just the hamburger); footer height/typography per mockup spec at 320/390; 721–900 band resolved per S0 decision; `chrome-markup.test.ts` / `ds-markup.test.ts` pins updated |
| S3 | IR-198 | Fleet clock section relocation per approved option | web | S0 | Section renders only in the approved location; **hidden entirely when `sparkNodes.length === 0`**; per-node apply outcomes legible on touch (not `title`-only chips); fleet apply 200/207/502 semantics and `fleetError` preserved; drift state reachable per approved design; **new mount test covers the section** (currently zero coverage); node-level History cards untouched |

Order: **S1 can start immediately** (independent, mechanical); S0 → S2 → S3 follow the mockup approval. All Medium priority (repo convention); no story points fabricated.

Verification gates per feedback-round lifecycle: `pnpm typecheck` + `pnpm test` (web mount/markup tests; db-gated suites unaffected — no db/server changes expected), `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check`; deploy as next `dev-0.6.0-N` tag; live browser pass at phone widths on 10.20.30.9:3947.

## Risks & open questions

1. **Screenshot question — RESOLVED (2026-11-07).** The owner re-shared the intended captures: phone-width Overview scrolled horizontally (page-level overflow on Overview itself — culprit to be found by S1's tree-bisect), the tall footer with stacked Transfers/Telemetry buttons, and the fleet clock caps card above the serving hero at ~784 px. S1 scoping is no longer blocked; the sweep remains the closure mechanism.
2. **"Bottom nav" referent — resolved.** No bottom tab bar exists; the bottom surface is the sticky footer (`App.vue:188–196`), and the 2026-11-07 screenshots confirm the pain: Transfers/Telemetry stack vertically beside the wrapped version line, making the footer a tall overlay. Remaining ambiguity (topbar wrap specifics, exact target height) is a design decision owned by the S0 mockup round.
3. **View-coverage ratchet (IR-175).** Any touched view needs mount tests; `ds-markup.test.ts`-style structural pins preferred over pixel geometry (IRI-124 lesson).
4. **Clock relocation interacts with IR-189 UX.** The 207-partial fleet-apply result and drift-streak semantics must stay legible after the move; `overview-shaped-ir84` assertions may need updating, and S3 adds the section's first mount test.
5. **Mockup-page latent overflow traps.** `.tip`-style hidden tooltip boxes and negative-margin nav paddings have bitten previous rounds (`mockups` gotchas 2026-10-23/29) — sweep, don't eyeball.
6. **Web-only deploy is cheap but not free:** next tag `dev-0.6.0-3`; rollback = previous tag; no migration risk.

## Jira overlap findings (project IR, live search 2026-11-06)

- **Zero open issues** — `project = IR AND statusCategory != Done` returned an empty result set (consistent with the v0.6.0 close-out emptying the backlog, incl. IR-176/IR-51 epics closed 2026-11-06). No duplicates possible; nothing to reuse as a child.
- Prior art (all Done), cited for context, not blockers:

| Key | Summary (status Done) | Relation |
|---|---|---|
| IR-20 | Mobile-first CSS pass: 390px audit for all M2 surfaces | Precedent for the 390px audit method; US1 re-runs the idea against today's surface set |
| IR-128 | Overview width tiers: small/medium/full density, range dropdown and hamburger below full | Existing mobile nav behavior (burger below full tier) |
| IR-92 | Shell: topbar settings CTA, scroll-free 2x2 settings modal, OFFLINE chip | Topbar button inventory |
| IR-80 | Overview footer: update interval + fleet watts | The likely "bottom nav"/footer referent |
| IR-129 | Fleet temperatures strip above heroes on small tier | Small-tier ordering precedent |
| IR-159 / IR-158 | Power and clock controls / clock endpoints | The clock section being relocated (IR-189 built on these) |

Created 2026-11-07 (owner-approved in-conversation): epic **IR-194** with stories **IR-195** (S0), **IR-196** (S1), **IR-197** (S2), **IR-198** (S3) — all To Do, parented to IR-194, added to sprint 998; per-key GETs verified `parent` for all four children. The brief is attached to the epic (attachment 16844) with a plain-text summary comment (id 25873). Next IRI task number for the implement half: 131 (tasks run to IRI-130).
