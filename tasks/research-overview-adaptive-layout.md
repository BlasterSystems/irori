# Research — Overview page adaptive layout (v2: 3 options + node-card declutter)

Date: 2026-11-27 · Repo: `main` · Surface: `apps/web/src` only (UI-local, no API/data change) · Mockup: `mockups/overview-adaptive.html` (toggle: 3 options) · Method: direct code read (file:line) + width arithmetic vs the IR-261 cap + two read-only expert reviews (PM `agent://PmReview`, UI/UX `agent://UxReview`, both repo-grounded, 2026-11-27) + live Jira overlap probe.

**Supersedes v1 of this document** (single-option proposal: 2×2 node grid + Power full-width + Token|NAS 2fr/1fr). Owner feedback 2026-11-27: cards still too stretched; node cards carry repeating constants; serving hero could be narrower with the reclaimed space put to work; asked for PM + UI/UX expert review, 3 options, mockups. That feedback is the design brief for v2.

## Tracker target

Project key **`IR`** · site **https://blastersystems.atlassian.net** · scrum board **5**. Resolved from `docs/DEVELOPMENT_PROCESS.md` §9 (`IRI-<number>`) + live-verified conventions in `tasks/research-feedback-round15.md` (Task type `10024`; no valid sprint → backlog). No tracker named in this conversation.

## Summary

Three asks across two feedback rounds (2026-11-27, screenshots at `dev-0.7.0-25`, 4 sparks + NAS):

1. **Cards are stretched everywhere** — the single-process serving hero spans 1296px with ~303px-wide stat tiles holding ~90px values; the NAS card stretches ~200px of content to fill 642px beside Power; the Token stats card lays six ~409px-wide tiles in two rows. Width-independent content sits in boxes 2–4× too wide (UX diagnosis "Disease B").
2. **Node cards repeat constants** — every card shows the SPARK kind chip, `Agent 0.7.0`, `NVIDIA GB10`, `/ 121.6 GB`, `/ 983 GB`. The user asked for these to move to tooltips.
3. **Reclaim the hero's width** — "the model being served card could have less width, and we could use that vertical space to accommodate something".

Root cause of the 4-node orphan + the stretch is the same: fixed grids (`cols-3`, 2-col hero-grid rows, full-width token row) designed before the IR-261 1360px cap made single rows this wide. Three structural options below; **both experts independently recommend Option 1 (Main + Rail)**.

## Current state (evidence)

| Fact | Evidence |
|---|---|
| Nodes grid fixed `.cols.cols-3` → 4 nodes render 3+1 orphan | `OverviewView.vue:653-656`; `irori.css:266`; screenshot 2026-11-27 |
| Serving hero spans full content width (`hero-grid--single`) | `OverviewView.vue:843-851` |
| Power \| NAS 2-col row; NAS content ~200px stretches to Power's ~380px | `OverviewView.vue:662-747` |
| Token stats full-width row, `statgrid--3`, 6 tiles in 2 rows | `OverviewView.vue:750-770` (IR-224 S7 comment) |
| Temps strip rendered small-tier ONLY (hidden ≥901px, IR-129) | `OverviewView.vue:930-934` (`html[data-tier="medium"/"full"] .tempscard { display:none }`) |
| Node card head: name + role chip + kind chip + `Agent x.y.z` + drift chip; GPU value built as `gpu.name · pct · watts · "used / total GB"` + temp | `NodeCard.vue:33-53`; `card-data.ts:91-99` (`formatMetricLine(gpu.name, …)`); MEM line `memUsed / memTotal` `card-data.ts:73-77`; DISK line `used / total` `:128` |
| GPU row also carries VRAM used/total when readable | `card-data.ts:91-99` (doc comment "NVIDIA GB10 · 34% · 42.1 / 127.0 GB") |
| Disk free-segment (orange, IR-98) + warn >80% are part of the row | `NodeCard.vue:42-44`; `card-data.ts:124-131` |
| Drift chip = `agentDrifts()` vs hub version — actionable state | `NodeCard.vue:22`; `version.ts:31-33` |
| Content column 1296px (cap 1360 − gutters), grid gap 12–16px | `irori.css:71,252`; IR-261 (Done) |
| `.cols-4` and `.cols-side` (2fr 1fr) primitives already exist | `irori.css:266-268` |
| Tooltip affordance exists: `Tip.vue` = hover-only, `aria-hidden`, `data-tip` | `Tip.vue:1-12`; `irori.css:278-290` |
| `.statgrid` collapses to 3-col ≤1100 → hero's 4 tiles orphan 3+1 (existing quirk) | `irori.css:530-532` |
| Tiers small ≤900 / medium 901–1440 / full >1440 | `apps/web/src/tiers.ts:14-20` |

Width math (UX-verified): today's GPU value ≈ 51 chars × 7.2px ≈ 367px vs a 304px value slot inside a 424px card → bar gets ~19% of the row; after declutter (~18 chars ≈ 130px) the bar grows to ~170px on a 424px card, ~100px on a 315px 4-across card.

## Node-card declutter spec (shared prerequisite for all options — both experts agree)

Head **before**: `DGX-1` + `HEAD` + `SPARK` + `Agent 0.7.0` (+ drift chip). Head **after**: `DGX-1` (+ name tooltip) + `HEAD` chip + drift chip when drifting only.

| Element | Disposition | Rationale |
|---|---|---|
| `SPARK` kind chip | **Remove** | Identical on all 4 cards = zero information (`sparkNodes` renders the grid); IR-103 spirit: chips signal state, not identity. NAS keeps its `NAS store` accent chip (differs per card type). Re-introduce only if fleets mix kinds. |
| `Agent 0.7.0` mono string | **Remove → tooltip** | Audit metadata, not monitoring data. **Drift chip stays** — `agentDrifts()` is the only fleet-consistency monitor on this page (PM: non-negotiable). |
| Role chip (`HEAD`/`WORKER`) | **Keep** | Differs per node; wayfinding. |
| GPU model name | **Remove from line → tooltip** | Homogeneous fleet; longest segment; exactly what truncates at 4-across. |
| MEM total (`114.7 / 121.6 GB` → `114.7 GB`) | **Remove → tooltip** | Constant per node; bar + warn carry the signal. |
| DISK total (`657 / 983 GB` → `657 GB`) | **Remove → tooltip** | Same; orange free-segment (IR-98) + warn accent stay visible. |
| Inference line (head: `:8000 TensorFold`) | **Keep** (PM proposed dropping — duplicates hero meta; UX keeps as live state) | Sub-decision at the gate; default keep to limit blast radius. |
| PKG watts row | Unchanged this pass (PM: demote optionally later) | Out of scope unless owner wants it. |

Tooltip content (attach to barrow **label** — dotted-underline + `cursor: help`, no per-row ⓘ icons; head name carries the identity string):

| Row | Visible after | Tooltip |
|---|---|---|
| GPU0 | `96% · 31 W · 65 °C` | `NVIDIA GB10 · VRAM 42.1 / 127.0 GB (33%) · per-node envelope 240 W` |
| CPU | `17% · 70 °C` | `GB10 20-core SoC · mean utilization across cores · PKG watts when readable` |
| MEM | `114.7 GB` | `Unified memory · 121.6 GB total · CPU and GPU share one pool` |
| DISK | `657 GB` + orange seg | `Internal NVMe · 983 GB total · 326 GB free · orange = available · warn > 80%` |
| Name | `DGX-1` | `NVIDIA GB10 · DGX Spark · agent 0.7.0 · unified memory 121.6 GB · NVMe 983 GB` |

**Touch/a11y fallback (required, UX):** `Tip.vue` is hover-only + `aria-hidden` → (a) gate compact values behind `@media (hover: hover) and (pointer: fine)`; on `hover: none` keep totals inline (`114.7 / 121.6 GB` — the small tier's 46px-label barrow already fits them); (b) make tips focusable (`tabindex="0"`, `aria-label` = tip text — fixes the AT gap); (c) universal fallback: the card links to node detail which carries everything.

**Thermal glanceability (resolves the PM/UX disagreement):** the PM proposed promoting the temps strip to desktop; UX rejected it (decluttered node cards keep temps → a desktop strip re-creates the duplication IR-29/IR-129 removed) and proposed instead a **degraded-only thermal alert row** (thread-tinted, above the heroes, rendered only when a node ≥ warn tier 70 °C — IR-103-compliant). Adopted: options 1–3 all use the degraded-only alert row; temps strip stays small-tier-only.

## Proposed design — 3 options

Interactive mockup with all three + real data: **`mockups/overview-adaptive.html`** (option toggle in the header; hover labels/values for tooltip content). All stay inside the 1296px column; all share the declutter spec + thermal alert row.

### Option 1 — "Main + Rail" — recommended by both experts

One asymmetric shell, existing `.cols-side` 2fr:1fr primitive (`irori.css:268`): main ≈856px, rail ≈428px.

- **Main**: hero (internal split: stats 2×2 left, sparkline right — tiles ~250px, chart ~700×130) → Nodes as **2×2** (~422px cards, ideal barrow width) → Power (chart ~820px, most legible of all options) → Token stats (`statgrid--3` → tiles ~275px).
- **Rail** (content-sized, top→bottom): NAS store (finally not stretched) → Fleet clock caps (stacked selects fit 392px inner) → Telemetry feed (rail citizen, frees page bottom).
- **Tier behavior**: ≤1100 shell stacks (main first, then rail); ≤900 single column, small-tier rules + temps strip as today; totals return inline on touch.
- **Multi-hero (2+ processes)**: rail pays off only with a single hero — spec: when >1 process serves, the shell collapses to full-width rows (heroes span main; simplest correct fallback).
- **Tradeoff**: largest restructure (NAS/caps/feed move DOM position); rail ends early on a 4-node fleet (intended, content-sized emptiness — the correct kind).

### Option 2 — "Signal Bands" — minimal DOM churn, no rail

Everything stays full-width rows; density is fixed inside the boxes:

- Hero narrows via **pairing**: hero 2fr (~856px, internal stats|chart split) | NAS 1fr (~428px) — NAS leaves the Power row, killing its dead space at the source (answers round-1 G2 directly).
- Nodes **4-across** at ~315px — viable **only because of** the declutter (values drop 51 → ~18 chars; GPU bar ~100px, tight but legible). Uses the existing `.cols-4` primitive.
- Power full-width (chart ~1200px, 24 hourly bars ~46px). Token stats collapses to **one `statgrid--6` row** (~196px tiles; delta labels still fit at ~125px).
- **Tier behavior**: ≤1100 the 4-up node row must explicitly become 2-up (override the generic cols→1fr collapse, which would stack four 1036px cards — today's worst stretch); hero split stacks; token 6-up → 3-col → 2 rows.
- **Tradeoff**: least structural change (no section moves, mostly CSS) and maximum vertical savings; node cards are the tightest surfaces on the page and the hero still reads as a full band.

### Option 3 — "Bento Mosaic" — densest, most distinct

4-column unit grid (units ~315px, gap 12–14), every surface spans 1 or 2 units, `align-items: start` (ragged bottoms are the aesthetic):

```
Row 1: Hero span-2 (642)  | DGX-1 | DGX-2
Row 2: DGX-3 | DGX-4      | Power span-2 (chart at its native 600px viewBox = pixel-perfect)
Row 3: Token span-2 (2×2 tiles ~295px) | NAS | Clock caps (stacked)
Row 4: Updates span-2     | Telemetry span-2
```

- Entire fleet + power + tokens above the fold at 1440×900; two serving processes = two span-2 heroes fill row 1 exactly.
- **Tier behavior**: ≤1100 → `repeat(2, 1fr)`; spans adapt (nodes/NAS/caps span 1 at ~645px — wide but barrows absorb width gracefully post-declutter); ≤900 single column.
- **Tradeoff**: best information-per-pixel; highest CSS churn (per-section span rules, not reusable row classes); unequal card heights within rows — some owners read bento raggedness as unpolished.

### Rejected (from the expert rounds)

- **Promoting the temps strip to desktop** (PM's variant): re-creates the duplication IR-129 removed once node-card temps are kept; replaced by the degraded-only thermal alert row.
- **Filling the rail with a temps/power mini**: duplicates live data that lives on node cards / Power card (PM's own rule: one home per datum).
- **v1's Quiet-Stack pairing (Token|NAS beside a full-width hero, nodes 3-across)**: the owner's round-2 feedback ("still stretched") rejects it; superseded.
- **4-across without declutter**: values truncate (the v1 math); only viable with the spec above.

## Approved design (owner gate 2026-11-27)

Owner picked **Option 1 with modifications** (gate answer + follow-up "create an adjusted mockup"):

- **Rail composition**: **Token stats moves into the rail** (rail order: token · NAS · clock caps · telemetry). Power stays in main (its 24 h chart needs a ≥560 px plot at rail width 428 it would shrink to ~390); Updates stays full-width (its table needs ≥640 px — horizontal scroll on mobile).
- **Responsive requirement**: the shell must adapt as the screen shrinks and ship a mobile version. Spec: shell 2fr/1fr ≥1101 → stacked ≤1100 (main first, rail follows) → single column ≤900; node grid 2×2 → 1-col; hero split stacks; token/power tiles → 2-col; updates table scrolls horizontally; temps strip reappears ≤900 (IR-129 unchanged).
- **Declutter extended**: the head-card inference line ("`:8081 TensorFold`") is also dropped (PM's suggestion, owner decision "also-drop-inference"). Constants survive via tooltips; on touch the totals return inline and node detail remains the full-data fallback.
- **Ticket creation approved** (one Task, backlog).

Mockup: `mockups/overview-adaptive.html` rewritten as the single adjusted design with a **tier toggle** (Full 1296 / Medium 1000 / Mobile 390); the mobile view demonstrates the touch fallback. No browser on this workstation — verified statically (selector wiring + one missing rule fixed); light/dark browser pass stays an implement-time step.

## Phased delivery plan

One approved Task (backlog). No ADR (UI-local; no data/interface/deployment boundary). Priority High (landing page).

**Ticket: [IR-282] — "Overview: adaptive Main+Rail layout + node-card declutter (mockup-first)" — created 2026-11-27 (Task, To Do, High, backlog, assignee bruno@blastersystems.com).**

- **Task (backlog, mockup-first)**: "Overview: adaptive Main+Rail layout + node-card declutter". Acceptance criteria:
  - Node cards: SPARK chip, agent version, GPU model name, MEM/DISK totals **and the head inference line** removed from the visible card; tooltips carry them (head identity string + per-row label tooltips); drift chip, role chip, offline strip/error border, orange disk free-segment, hot-temp accents all still render; compact values gated behind `(hover: hover) and (pointer: fine)` with totals inline on touch; tips focusable with `aria-label`.
  - Thermal alert row renders only when a spark node ≥ 70 °C (warn tier), hidden on healthy fleets; temps strip behavior unchanged.
  - Approved layout renders per tier spec (see "Approved design"): rail = token · NAS · caps · telemetry; Power + Updates full-width; nodes 2×2 at 4; no `.statgrid` 3+1 orphan on the hero at ≤1100; single column ≤900 with totals inline.
  - `card-data.ts` line builders updated (pure, test-pinned) + web mount test for the new class bindings + NodeCard tooltip content; `pnpm test` + `pnpm build` green.
  - Mockup `mockups/overview-adaptive.html` browser-verified light/dark at implement time (IR-261 recipe).
- Deploy: web-bundle-only, standard pipeline; functional probe = overview renders at `/`.

## Risks & open questions

1. **Option choice is the owner's call** — the three tradeoffs (rail vs bands vs bento) are taste plus churn; both experts picked Option 1 but Option 2 is the smallest diff.
2. **Multi-process heroes** — Option 1's rail assumes a single serving hero; >1 process needs the documented collapse-to-rows fallback. Confirm the fleet rarely serves 2+ setups simultaneously (today: 1).
3. **Tooltip reachability** — hover-only tooltips + touch fallback (totals inline) means tablet/mouse-less users see the old, longer values; acceptable (UX), but note the implement-phase media-query gating.
4. **Inference line on head cards** — PM would drop it (duplicates hero meta), UX keeps it (live state); default keep, decide at the gate.
5. **Option 2's 315px node cards** are the information floor — a fifth spark forces a cols-3 reflow; fine for the 4-spark reality, revisit if fleets grow.
6. **IR-224 S7 supersession** — Token stats leaves its full-width row in every option; rationale recorded here; owner mockup sign-off is the guard.

## Overlap findings

Live JQL on `blastersystems` 2026-11-27: open tickets matching `overview / layout / NAS / dashboard / card / tooltip` → **0**; open epics → **0**. Related Done: IR-261 (centering — hard constraint cited), IR-224 S6/S7 (power window pin kept; token row superseded with rationale), IR-129 (temps strip tier gate — kept, plus new degraded-only alert), IR-98 (disk free-segment kept), IR-103 (absence-of-chrome rule — the declutter + degraded-only alert follow it), IR-127/IR-128 (hero head, width tiers). No duplicate ticket; nothing to link or close.
