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
