# Mockup iteration plan — round 3: Overview density (hero chrome, mobile height, fleet temps)

Status: **reviewed + findings applied 2026-10-29** — `overview-v4.html`,
awaiting owner approval for the Vue port.
Inputs: owner screenshots (desktop 1568×578, phone 851×1568), `OverviewView.vue`
current markup, IR-103 node-card precedent, SPEC §9 (temps), round-2 method.

---

## Triggers (owner)

1. **"ttft · itl appear with the first requests" makes no sense** — the
   placeholder line is permanent chrome for a transient fact; it never removes
   itself early and wastes a full row on every hero card, including a second
   line on phone width.
2. **Too many chips in the hero header** (`ENGINE`, `TENSORFOLD :8081`,
   `○ SERVING`) — owner wants state **only when offline**. On phone width the
   three chips wrap to a second header row (≈40 px/card, two cards on screen).
3. **Mobile / short width must be denser** — lower card height so more
   information fits; plus an **always-visible card with the temps of all nodes
   (NOT the NAS)**.

## Decisions carried into the mockup

> **Superseded in part by round 3b below**: the `body.compact` ≤720 trigger is
> now `html[data-tier="small"]` ≤900, the fixed bottom temps **dock is gone**
> (inline card above the heroes on small only), and hero charts no longer
> shrink to 84 px — they are **hidden on small only**; medium shows them
> (owner's round-3b final call). The rest stands.

- **No ttft/itl placeholder, ever.** When `ttftP95Ms/e2eP95Ms/itlP95Ms` are
  null the stats simply do not render (grid 4-col). The first request replaces
  dashes with values on its own; no instructional line. (Deletes
  `OverviewView.vue:433` and the IRI-025 decision it came from.)
- **Hero header = model title + plain mono meta line**
  `tensorfold :8081 · DGX-1` (+ `· unmanaged` for probe-detected engines with
  no setup). No chips while healthy — same IR-103 rule the node cards already
  follow: healthy is the absence of chrome.
  - Non-healthy states DO appear, as the only chip: `chip--warn` `OFFLINE`
    (probe stale / setup died while the card is up) and `○ starting` while
    weights load (transient, so the card never looks silently dead).
- **Compact tier (≤720 px, plus any short-width config)**: page-scoped
  `body.compact` class (media query sets it; a mock control force-enables it
  on desktop so experts can review it):
  - stat values 20→15 px, labels 11→10 px, card head/body padding
    12/16→8/12 px, chart 130→84 px, power chart 96→64 px,
    section margins 20→12 px, log max-height 220→120 px,
    seg buttons 34 px (touch-target compromise: 44 px kept only for real
    tap targets like .btn; segmented range control allowed 34 px — a11y risk
    flagged to reviewers).
    *(3b supersedes the specifics: head/body padding is 7/10 and 9/10 px,
    the hero chart is hidden on small instead of 84 px, and the seg is
    replaced by a 44 px native select below full.)*
  - hero grid stays 1-col but each card drops from ≈800 px (phone shot) to
    ≈230 px: one head row, 2×2 stats, 84 px chart. *(3b: chart hidden there,
    card measures 237–262 px.)*
- **Fleet temps card** (`Node temps`): spark nodes only, NAS excluded by
  definition (same rule as the fleet power card). One item per node:
  `DGX-1 71°/62°` (GPU/CPU, hot tier ≥70 °C in thread-ink, ≥90 critical).
  - Desktop: node cards keep their detailed rows; the shared thermal glance is
    the page-head `hottest 71°C DGX-1` token, so no dedicated card at
    medium/full (round 3b).
  - Small tier: a slim inline card ordered **above** the hero cards (node
    cards are below the fold there). Offline node → `— OFFLINE` item.
    (An earlier fixed bottom dock was dropped in 3b: the owner asked for the
    strip at the top of the page, not pinned.)

## Method

Senior UI/UX + senior PM parallel review of `overview-v4.html` (rubric per
round 2), light/dark + desktop/compact screenshots; findings applied before
presenting to owner.

## Deliberately out of scope

- Telemetry drawer/streaming (IR-124), power/NAS card content (unchanged),
  node card internals (unchanged), topbar density (flagged, not changed).

## Round-3 review outcomes (applied 2026-10-29)

PM + UX expert reviews (PM verified live-hub facts; layout numbers measured by
the parent session in Chromium, 390×844 + 1568×900, light/dark):

- **starting state** (MAJOR): the third hero scenario — `○ starting` chip
  (dot--run, not warn) while weights load; latency stats hidden. The Vue port
  MUST include `status === "starting"` setups in `heroProcesses` (today's
  `running` filter hides the hero for the whole load).
- **dock vs sticky footer** (MAJOR): app footer is `position: sticky;
  bottom: 0` (version·tag promise). Dock sits `bottom: var(--dock-foot-h)`
  (measured footer height, JS-set) — both visible, verified.
- **critical tier**: `≥90 °C` renders `.crit` (thread-ink 600 + ▫ prefix) —
  warn and critical no longer identical (matches Analytics glyph convention).
- **unreadable temp**: online node with null temp renders `— gpu — cpu`,
  sorts below hot nodes; `— OFFLINE` reserved for node-down.
- **node-down cascade**: fleet-down also stale-marks that node's hero card.
- compact touch targets raised to 36px seg / 34px btn; power chart 64px in
  compact; `+1 worker` spelled out; dock right-edge fade signals overflow;
  density control stays reachable in forced compact.
- **tip::after** hidden via `display:none` (not opacity) — otherwise the
  300px tooltip box creates phantom horizontal scroll (measured: 426 at 390).
  Same defect likely latent in every mockup using the shared `.tip` pattern.

Measured: phone 390×844 first screen = BOTH hero cards (326px each, was
≈800px) + temps dock + sticky footer; zero console errors; no horizontal
scroll 320→1568; thread used only for warn/live/avg/brand-line and, on the
hero chart, the decode series (matching the shipped LensChart palette,
`analytics.ts` series 0 = thread).

UX review (applied): 10px floor for `.tempitem__v em`, compact `stat__label`,
dock label; `card--stale` dims VALUES (.75) not the whole body (labels keep
AA contrast); `.tip` gains `tabindex=0` + `:focus-visible::after`; dock is
`role=region` + `role=list/listitem` and values read `71°C gpu`; compact
`.hero__meta { flex:none }` so `· unmanaged` never truncates first;
`--dock-foot-h` re-measured on `document.fonts.ready` + resize; section/h2
margins moved from inline styles to `.section-gap`/`.h2-gap` so the compact
tier reaches them (12px); node-down stale now survives a heroSeg scenario
click; compact `.hero__title` 15px ≥ stat value; mock-note hidden compact.
Card height after typography floor: 329px (still 2 heroes + dock + footer).
Not applied: NIT-9 (36/34px targets accepted — WCAG 2.5.8's 24px floor, the
44px one-hander tradeoff is a plan-level owner decision); NIT-10 (chart
series identity comes from the ported LensChart hover labels); NIT-11
(fleet-count line stays — removing the count loses info for 24px).

## Round 3b — explicit tiers (owner second pass, 2026-10-29)

Owner screenshots: 772×1568 (smallest) and 1318×1568 (medium) plus the full
width, with per-tier demands. Implemented as `html[data-tier]`
(`auto|small|medium|full`) set from media queries in JS + a mock tier control.

| | small ≤900 | medium 901–1440 | full >1440 |
|---|---|---|---|
|hero grid|1 col|2 col|2 col|
|hero sparkline|hidden|**shown** (owner final call)|shown|
|range filter|`<select>`|`<select>`|seg buttons|
|nav|hamburger menu|hamburger menu|inline row|
|fleet temps card|**shown, above the heroes**|hidden|hidden|
|gutter|12px|24px|centered 1200|

Breakpoint choice: **900px, not 720** — the shipped `.hero-grid` already
collapses to one column at 900 (`OverviewView.vue`), which is exactly the
single-column layout the owner screenshotted at 772. Temps survive only on
small because there the node cards (which already print GPU/CPU temp per row)
are below the fold; on medium/full the strip was duplicate information.

Two real bugs found while measuring, both fixed:

- **Flush edges 721–1200** (owner ask 1): `.page`'s `padding` shorthand zeroes
  `.container`'s 24px left/right — equal specificity, later in `irori.css`.
  Fixed with `main.container { padding-left/right }` (element+class wins),
  and the small tier needs `width: 100%` because on a flex item
  `.container`'s `margin: 0 auto` disables cross-axis stretch and shrink-wrapped
  `main` to its content (that produced the oversized asymmetric side space).
- **Min-content blowout**: small tier used `grid-template-columns: 1fr`, whose
  min-content floor let a long model name widen the whole card past the
  viewport (457px at 390). Now `minmax(0,1fr)` like the base rule; the title
  ellipsizes instead.

Verified in Chromium at 320/390/600/720/772/900/901/1318/1440/1441/1568:
tier assignment, gutter symmetry, 1- vs 2-col hero, chart/seg/select/nav
visibility per tier all correct; no horizontal page scroll anywhere; 4 hero
cards with 47-char titles truncate without overflowing; 8-node temps strip
wraps (no h-scroll); hamburger opens a 210×318 menu with 7 links,
`aria-expanded` wired, Escape and click-outside close it; the range `<select>`
and the seg drive one `applyRange` state. Hero cards at small: 262/237px
(329 with charts). Zero console errors.

## Round-3b review outcomes (applied 2026-10-29)

Expert UX pass over the tier system — 10/10 owner asks MET, then:

- **MAJOR (fixed): node card carried a healthy-state `ONLINE` chip.** The
  shipped `NodeCard.vue` IR-103 rule is *no chip while online*; offline is
  error border + full-width `.offline-strip` + dimmed body. Mockup now mirrors
  that exactly; `card--stale` (thread border) is reserved for probe-stale
  engines only.
- **F2 (fixed):** small-tier footer was flush (its own `padding: 8px 0` beat
  `.container`) and 64px dead gap above it — now `8px 12px` + `margin-top:
  space-3`; topbar inset aligned 16→12 to match the content gutter (N2).
- **F4 (fixed):** 44px touch floor restored on the phone `<select>` and
  "Add node…"; medium-tier burger enlarged to 44px (tablets live in medium).
- **F5 (fixed):** menu closes on link activation (SPA keeps the topbar
  mounted), Escape returns focus to the burger, `aria-label="Primary menu"`
  no longer duplicates the nav landmark.
- **F6 (fixed):** thermal glance survives medium/full as a page-head token
  `· hottest 71°C DGX-1` (thread-ink ≥70); small temps strip is
  `auto-fit minmax(160px,1fr)` so an 8-node fleet is ~4 rows, not 8.
- **F7 (fixed):** small hero head wraps; title floor `min-width: 8ch` so a
  long meta can't ellipsize the model name to nothing.

**Accepted tradeoffs (do not relitigate in the port):**
- Hero sparklines shown at medium (owner's final call 2026-10-29: "show the
  decode/prefill charts on medium"); hidden only on small, where `peak` +
  Analytics are the substitute.
- The inherited `irori.css` ≤1080 block still steps `.statgrid--6` to 3-col
  and `.cols-3` to 2-col inside medium — pre-existing shipped behavior,
  intended.
- Port must keep `.hero-grid--single` (one process spans the row) and the
  empty-state ghost grid, and expect `#connChip` to wrap in the ≤720 topbar.

## Deliverables & acceptance

- `mockups/overview-v4.html` — tier control (auto / small / medium / full),
  2nd-hero scenarios (serving / starting / no requests / engine offline /
  unmanaged), fleet scenarios (online / DGX-3 offline / DGX-2 no sensor),
  range on both surfaces.
- Light/dark × 320→1568 screenshots, zero console errors.
- Vue-port notes: delete the ttft placeholder line; hero chips → meta line +
  state-only chip (incl. `starting` setups in `heroProcesses`); a tier store
  (`small|medium|full` from the 900/1440 breakpoints) driving hero-chart
  render, seg-vs-select, nav-vs-menu, and the temps card (rendered only on
  small, ordered above the heroes); port `mockups/irori.css` gutter fix
  (`.page` shorthand zeroes `.container`); `minmax(0,…)` on every track that
  holds a truncating title; test-pin updates in `overview.test.ts`.

## IRI-048 — transfer surfaces options round (2026-10-29)

Owner report: closing the Models job sheet strands a running sync-local/push —
no list, no bar, no cancel anywhere (screenshot against dev-0.3.0-57).
IR-131 carries the plan (tasks/IRI-048-transfer-tracking-and-cancel.md); this
mockup decides the SURFACE shape.

- `mockups/IRI-048-transfer-surfaces.html` — five scenes: (1) shared row
  anatomy (running single-stream, 4-stream aggregate, totals-pending honest
  state, queued, canceling, canceled+staging, failed+remediation, succeeded;
  inline confirm with blast-radius copy), (2) shape A Models strip + op bar,
  (3) shape B global transfers dock (Telemetry-dock idiom, footer CTA +
  count bubble), (4) shape C #/transfers route (filters, pinned active),
  (5) tradeoffs table.
- New page-scoped vocabulary: `.xrow-main` 5-col grid, `.dock` rows,
  `.opbar`, `.countbub`, `.xconfirm`/`.dconfirm` inline confirms.
  Promote to irori.css only after the owner pick.
- Verified: light/dark full-page shots, zero console errors, width sweep
  320→1568 clean (fixed: xrow grid mins overflowed at 721 → flush bodies now
  always `overflow-x:auto`; topbar nav overflowed 721–900 → brand
  endorsement hidden + nav tightened ≤900). Interactions green: row confirm
  open/close, dock toggle, disabled Output on the canceling row.
- Open owner decision: shape A / B / C (recommendation A+B now, C as B's
  history target later).

## IRI-130 — mobile shell & clock placement options round (2026-11-07)

Status: **built + browser-verified 2026-11-07** — `IRI-130-mobile-shell-clock-options.html`,
designer+PM review round in flight, awaiting owner pick. Stories: IR-195
(this mockup), IR-196/197/198 (implementation), epic IR-194. Brief:
`docs/research/IRI-130-ui-feedback-round-7-research-brief.md`.

Inputs: owner captures (390 px phone with the page scrolled sideways; footer
stacked 3 rows; clock caps card 2nd on Overview at ~784 px), brief §5.1–5.3.

- Scenes: S0 today-baseline (callouts ① 34 px topbar controls ② footer 3 rows
  of 28 px CTAs ③ clock caps above the hero), S1 44 px floors (390+320),
  S2 footer B1 one-row 60 px (drops wordmark/cadence/tag; watts hidden <390),
  S3 footer B2 two-row 84 px (keeps the tag, drops cadence), S4 footer B3
  status-only (CTAs move into the menu), S5 band keep-vs-consolidate (frames +
  table), S6 empty-fleet hide rule, S7 clock A demote below Power, S8 clock B
  pagehead affordance + bottom sheet (interactive; per-node outcome ROWS),
  S9 clock C fold into Updates (collapsed/expanded).
- New page-scoped vocabulary: `.phone/.ptop/.pbody/.pfoot/.psafe` frames,
  `.call` annotations, `.afford` pagehead chip, `.sheet`/`.scrim` drawer,
  `.orow` outcome rows, `.uprow`/`.upbody` fold, `.clockrow(--end)`/`.btngroup`,
  `.pv-watts`, `.countbub` copy. Promote to apps/web only after the owner pick
  (stories IR-197/IR-198).
- Fixed during verification: 721–900 topbar overflow (endorsement hidden + nav
  tightened ≤900 — the known page-scoped fix), missing `#cBody` in the
  collapsed fold (nextElementSibling null), B1's false one-row claim (the
  version wrapped at 320 → honest content set: drops wordmark/cadence/tag,
  watts hidden <390), footer CTAs now 44 px in option frames (the S0 baseline
  keeps 28 px), Apply/Clear grouped right on their own row (44 px CTAs overflow
  the checkbox row at 390), sheet scrollbar hidden (mobile overlay idiom).
- Verified: light+dark full-page shots; scrollWidth sweep clean at
  320/390/480/720/721/900/1024/1568 in both themes; 0 console errors;
  interactions green (sheet open/close/scrim, fold aria-expanded, theme).
- Open owner decision: footer B1/B2/B3 + band keep/consolidate + clock A/B/C
  (recommendations B1 / keep / B).
- **Review outcomes (applied 2026-11-07, designer + PM static rounds):** P1 —
  the 320 px frames' "endorsement hidden" claim never fired (data-tier was on
  `.ptop`, not `html`) → `.ptop--compact`; the recommended option's own
  controls had no 44 px floor → `.phone .afford`, `.sheet .btn/.select/.iconbtn`.
  P2 — S7 now carries the persistence checkbox + ceiling tip (was misstating
  option A); drawer/fold gained the fleet status line (`role=status`,
  200/207/502 semantics) and the persistence checkbox defaults UNCHECKED
  (app truth: `fleetPersist` starts false); S7/S8/S9 footers now depict the
  recommended B1 (they showed a nonexistent fourth footer); B1's deploy-tag
  home is committed AND depicted (hamburger-menu footer line
  "deploy dev-0.6.0-2"); S5's revisit trigger no longer conflates the clock
  complaint with the band decision; topbar inventory identical
  (theme+gear+burger) in every option frame; recommendation chips upgraded to
  `.chip--pick` (`chip--accent` was identical to `chip--ok`); S8 gained a
  320 px open-sheet frame; "per-node caps untouched" stated; `.psafe` to
  muted (AA 4.5:1); `.phone--378` defined; inline-style rhythm moved to
  classes (`.pfoot__ver`, `.pfoot__in--end`, `.pt-sm`, `.clockrow--end`);
  sheet scrollbar hidden (mobile overlay idiom); focus moves into the dialog
  on open.
- Re-verified after fixes: scrollWidth sweep clean 320→1568 in light AND
  dark; 0 console errors; drawer open/close/scrim/fold asserted; focus lands
  on the dialog close; status line + unchecked persistence asserted; 16
  frames.
- **Owner decision (2026-11-07): footer B1, band keep, clock A.** IR-197
  implements the B1 footer (44 px floors included, plus the hamburger-menu
  deploy line "deploy <tag>"); IR-198 demotes the EXISTING fleet clock caps
  card below Nodes/Power — hidden when there are no spark nodes, per-node
  outcome chips made touch-legible, fleet status line and error banner kept,
  200/207/502 semantics preserved, node-level History cards untouched; the
  IR-175 mount test still lands with it. S8/S9 remain as
  considered-and-rejected depictions; the drawer vocabulary (.sheet/.afford/
  .orow) stays page-scoped unless a later round promotes it.

## DS v1.1 adoption round (2026-11-12)

Status: **built + browser-verified 2026-11-12, awaiting owner review.**
Proposal of the new BlasterSystems DS v1.1 (identity v0.2, oklch) applied to
the three main Irori screens. Kit:
`~/Developer/BlasterSystems design system v1.1/`; reference port:
`uptime-monitoring/tasks/mockups/ds-v11-dashboard.html`.

- Files: `irori-v11.css` (shared: oklch tokens copied VERBATIM light+dark,
  type/spacing/effects, panels, chips, glyphs, buttons/filters, underline
  fields, tables, log, drawer/scrim, charts, sidebar shell) + three screens
  `v11-overview.html`, `v11-serve.html`, `v11-models.html`. Fonts: added
  `fira-sans-latin-300(-ext).woff2`; existing 400/500/600 + DM Mono reused.
- IA/content deliberately UNCHANGED from the approved rounds (overview-v4
  tiers, serve states, models catalog) — this round only swaps the DS skin;
  the owner's density/chrome decisions carry over. The overview tier
  machinery is not re-implemented here; responsive behavior is simplified
  (sidebar → hamburger ≤900) and the tier rules from overview-v4 apply on
  port.
- Key deltas vs the current `irori.css` skin: 232px paper-2 SIDEBAR + topbar
  (nav moves out of the topbar; hamburger ≤900) · page titles 30/500 · oklch
  tokens (dark paper #0e1217, much darker than v1.0) · panels are `--card`
  on `--paper` with 1px rule · buttons ink (`--action-bg`), one filled per
  screen, destructive = thread-ink text link (`.bs-link--thread`), never a
  fill · fields are UNDERLINE (`.bs-field__box`) in forms/drawer; toolbar
  keeps a bordered select/search hybrid · charts get the v1.1 idiom (y-label
  column, grid lines, mono uppercase x labels, legend swatches); hero
  sparklines stay bare · log console keeps force-dark values taken from the
  v1.1 dark palette · thread discipline unchanged: line/live/warn only, one
  held chip per screen (serve: embed-eval FOREIGN; overview/models: none,
  healthy).
- Data unified to the live fleet naming across the three pages (DGX-1/2/3 +
  NAS, agents 0.7.0, hub dev-0.7.0-13, GLM-5.3-Flash-EXL3 :8081 on
  DGX-1+DGX-2, Qwen3.8-Flash-Next :8082 on DGX-3, decode 38 peak 63, NAS
  14.2/18.1 TB · 148 models · modelctl v0.24.0, jobs j-218 push GLM→DGX-3
  37% + j-217 queue download 12% — replaces the stale spark1/2/3 + 2.4/8.0
  TB data in serve/models).
- Verified (Chromium 1568×950 + 320/390/480/600/720/721/780/900/1024):
  light+dark full-page screenshots on all three pages, 0 console errors;
  scrollWidth sweep clean 320→1568 both themes (fixed: models store barrow
  had a fixed 140px column that overflowed 320 — now `.storebarrow` with a
  minmax narrow-tier override); serve drawer open/close + Escape + paper
  scrim; models store-health popover open/Escape; hamburger menu open/close
  at 780 (thread line on the current item).
- Verification gotcha: the driven tab served a STALE cached iroiri-v11.css
  after edits (HTML ?v= busting doesn't refresh the stylesheet) — bump the
  link href with a query before trusting computed styles.
- IA/content: the SKIN is the only thing this round proposes; the IA contract
  stays with the previously approved mockups + SPEC. Corrections after the
  adversarial review (2026-11-12, PmReview/DesignReview/EpicAdversary — see
  IR-214 evidence): v11-serve does NOT re-depict the starting·transferring
  staged-transfer card or the wizard entry (carried from approved serve.html +
  SPEC §7, AC on the Serve child); v11-models does NOT re-depict the detail
  drawer (armed delete, remediations, capacity math) or the download modal
  (carried from approved models.html + SPEC §6, AC on the Models child); NO
  v1.1 page depicts non-healthy states (starting/stale/offline/unmanaged/
  failed/no-sensor/fleet-down — IR-103 rules + round-3 outcomes, AC on the
  Overview and Serve children). Fixed in place after review: nav Serve count
  4 everywhere (total setups), "8 of 148 · page 1 / 6", store-health
  "148 active", planned placement chips lose the run glyph, hamburger menu
  gains the deploy-tag + live line (IR-197), jobs footer copy "jobs stream",
  240 W per-node envelope dash + legend restored.
- Adversarial review (2026-11-12, pre-implementation variant, IR-214):
  three read-only reviewers — PM (PmReview), senior UI/UX designer
  (DesignReview), epic-mechanics adversary (EpicAdversary) — over the three
  screens + epic text, with a parent-measured Chromium fact pack pushed to
  each (contrast via oklch→sRGB with alpha compositing, thread counts,
  geometry, 12-width overflow sweep, interaction asserts). Verdicts: skin
  port conformant (tokens byte-verbatim, one filled button/screen, thread
  discipline, chart alignment, 0 errors, no overflow); the blockers were
  silent IA drops and epic-text gaps, not skin defects.
  - Fixed in mockups after review: nav Serve count 4 everywhere, "8 of 148
    · page 1 / 6", store-health "148 active", planned placement chips lose
    the run glyph, hamburger menu deploy-tag + live line (IR-197), jobs
    footer copy "jobs stream", 240 W envelope dash + legend restored,
    bs-info span → button + tip flips left-anchored, drawer focus
    management + aria-modal, pagination aria-current, glyph optical sizes
    (9/8 outline, 7/8 filled per kit), reduced-motion iteration-count,
    h2 on the token scale, field-label tracking 0.06em, blur 12px,
    alert warn-glyph nudge, statgrid--6 defined, spark vector-effect,
    latin-ext 300 face, −15m label centering. All re-verified in Chromium.
  - Pinned in the epic: IR-197 footer supersession (deploy tag keeps its
    hamburger home; version/watts → sidebar foot + refresh-note), chrome
    homes (gear, countbub, offline warn chip), markup vocabulary strategy
    (keep Irori class names, change values; bs-* only for new components),
    tier machinery port, enumerated sweep widths + contract names,
    validation surface, spark1/2/3 bullet reworded, destructive-scope +
    one-filled-per-surface definitions, tasks/IRI-NNN per child.
  - Carried as AC into children IR-215…IR-223 (filed on sprint 1004).
  - Owner decisions taken with defaults (flagged in the evidence comment):
    serve count = total setups; catalog = full 148; footer superseded per
    mockup; vocabulary = restyle in place; log .ok green ratified;
    info tips stay 300px popovers; destructive rule scoped to the three
    screens + shared components; one filled button per visible surface.
- Not in this round (follow-ups if approved): nodes/node-head/analytics/
  benchmarks/cleanup/wizard screens, the full overview tier system, dark-
  first log review, and promoting `irori.css` toward `apps/web` tokens.

## Round 8 revision — deployed skin kept, decision mockup (2026-11-13)

Status: **revised after owner review + re-verified 2026-11-13** —
`v14-round8.html` + `irori-v14.css` (delta over the deployed v1.1 skin,
imported verbatim). Epic IR-224 (stories IR-225…IR-232, backlog); research
doc `tasks/research-ds-v14-ui-feedback-round-8.md` (gate decisions +
revision recorded there); pre-gate adversarial review: 24 findings.

Owner corrections (2026-11-13): **keep the deployed colours** (light/dark
v1.1 palette — no mist/stone/dusk, no theme menu; the v1.4 four-step scale
is declined) · power + token stats keep their **current lower positions**
(power in its hero-grid row; token stats takes the NAS card's token slot) ·
range + Add node live **in the menu** (sidebar tools; hamburger ≤900;
collapsed rail: Add node icon + JS-positioned range popover) · the topbar
gains an **inference-server performance chip** on every page (live decode +
watts, compressed ≤900) · everything else identical to the deployed app.

- Verified (headless Chromium): deployed skin renders identically
  (auto-dark `#0e1217` via the imported block), 2 themes × 11 widths
  (320→1568) zero overflow (fixed: perf-chip compression), 0 console
  errors; collapse 232→68px with count bubbles + range popover escaping
  the rail's overflow clip; drawer panel never scrolls, body scrolls at
  the 88vh cap, typed "DGX-1" arms the destructive CTA, Escape closes.
- Defects found and fixed during review: missing SVG series rules (charts
  rendered black), popover clipped by sidebar `overflow-x: hidden`,
  series palette now follows the deployed LensChart idiom (decode thread,
  prefill ink-2, bars filled ink / current hour thread).
- Token stats card content unchanged from the first pass (owner OK): 8
  tiles, DS-calm mono deltas, default 24h, follows the menu range.
- Effect on stories: IR-227 (S3 tokens/theme runtime) is obsolete as
  written; IR-226 (S2 ADR-0019) likely unnecessary (no token migration);
  IR-228 (S4) gains the perf chip and moves range/Add node into the menu;
  IR-230/231 positions per the deployed layout. Revision comments posted
  on the epic and affected stories.

Second owner pass (2026-11-13): three corrections applied to
`v14-round8.html` and re-verified —
- Perf chip is NOT on every page: it appears once the user navigates away
  from the Overview (its serving heroes already carry decode + watts
  there); hidden on the Overview itself. Mockup: hidden by default, new
  "Away page · chip" mock-bar scene previews the chip state. (IR-228)
- Power card is pinned to the 24 h window — by default AND when 30 m is
  selected it does not follow the menu range: energy, cost, hourly chart
  and window avg stay on 24 h; Fleet now stays minute-fresh. (IR-230)
- Token stats card moved to directly BELOW the NAS card (owner: "below or
  around the NAS card"); NAS keeps models/store; production keeps the
  deployed Power | NAS hero-grid pairing, token stats as its own row
  after it. (IR-231)

Follow-up (same day): after the owner flagged the missing sections, the
mockup was rebuilt to render the FULL deployed Overview — health banner
(IR-203/204) with the cleanup CTA wired to the drawer scene, Fleet
temperatures (IR-129), Nodes cards, Fleet clock caps and Updates
(IRI-081) are untouched deployed surfaces — and the hero tiles were
aligned to the deployed anatomy (Decode/Prefill/Queue/KV cache/TTFT/ITL).
Re-verified: section order matches OverviewView.vue, 12 widths 320→1568
zero overflow (added a ≤480 barrow wrap override), cleanup CTA opens the
drawer scene, light + dark clean, 0 console errors. Implementation plan:
`tasks/IR-224-round8-implementation-plan.md`.
