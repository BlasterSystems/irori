# IRI-036 research brief — Overview feedback round 4 (section order, feed auto-scroll, per-series hero scale)

- **Date:** 2026-10-27
- **Ticket:** IRI-036 (epic IR-107, stories IR-108..IR-110)
- **Goal:** Decision-complete answers for three owner changes to the Overview page: (1) the Nodes section swaps places with the Power/NAS row, (2) the Telemetry feed always shows the latest data by scrolling down, (3) the active-model chart scales decode and prefill independently "so we always see relevant info" (owner screenshot: prefill hugs the baseline while decode spikes dominate a shared scale).

All questions are answerable from this repository; no external behavior is unknown. Evidence is local primary sources.

## 1. Where do the Overview sections live, and what exactly swaps?

`apps/web/src/components/OverviewView.vue` template order (read 2026-10-27):

| Order | Lines | Block |
|---|---|---|
| 1 | 405–433 | Serving-process hero cards (`section.hero-grid`, `v-if="heroProcesses.length > 0"`, ghost fallback 434–437) |
| 2 | 435–503 | `<!-- Fleet power + NAS store -->` — one `section.hero-grid` with the Power card and the NAS card |
| 3 | 504–512 | `<h2 style="margin: 20px 0 10px;">Nodes</h2>` + `section.cols.cols-3` of `NodeCard`s (ghost fallback included) |
| 4 | 514–523 | Telemetry card (`section.card`, feed `.log`) |

- The owner ask: "the nodes section switches places with Power and Nas" — i.e. block 3 moves above block 2; blocks 2 and 4 keep their relative order.
- Spacing is margin-based, no wrappers: heroes carry `margin-bottom: 12px` (line 405), the fleet grid `margin-bottom: 12px` (line 436), the `h2` `margin: 20px 0 10px` (line 504), the nodes grid no vertical margin, Telemetry `margin-top: 20px; margin-bottom: 12px` (line 514). Adjacent siblings' vertical margins collapse (CSS 2.1 §8.3.1), so after the swap the `h2` (20px top) sits under the heroes' 12px bottom margin at an effective 20px, and the fleet grid needs an explicit `margin-top: 20px` to keep its separation from the nodes grid.
- No test pins the section order. `apps/web/test/overview.test.ts:232-238` pins `>Telemetry</h3>`, `class="hero-grid"`, `heroProcesses`, `fetchLlmHistory(nodeId, range.value)` — all order-independent; `ds-markup.test.ts:55-58` pins vocabulary classes only. The swap breaks neither.

## 2. Why can the latest Telemetry line be invisible, and what is the minimal fix?

- The feed is `feed` in `OverviewView.vue:251`: `feedLines(live.events.value, …, 120, …)`. `feedLines` maps frames to lines **newest last** and caps at `cap` (`apps/web/src/overview.ts:333-334` doc comment: "Maps feed frames to display lines, newest last, capped").
- The container is a `.log` div with `min-height: 120px; max-height: 220px` (OverviewView.vue:517). `.log` has `overflow: auto` (`apps/web/src/assets/irori.css:209-210`), so once lines exceed 220px the box scrolls — and there is **no scroll management anywhere in the web app**: `grep -r "scrollTop|nextTick" apps/web/src` returns nothing (verified 2026-10-27). New lines appended at the bottom stay out of view; the owner sees stale top lines.
- Fix: template `ref` on the `.log` div + `watch(feed, …)` → `await nextTick()` (DOM must update first) → `el.scrollTop = el.scrollHeight`. `watch` is already imported (OverviewView.vue:2); `nextTick` is a one-token import addition.
- Tradeoff recorded: unconditional auto-scroll also yanks the viewport down while the owner reads history. The ask is explicit ("always shows the latest data added, scroll down"), so unconditional wins; a stickiness guard ("only if already at bottom") is a 1-line later change if the owner wants it.

## 3. How is the active-model chart scaled today, and what is the minimal per-series change?

Current geometry chain:

- `heroSpark` (`apps/web/src/overview.ts:96-110`) builds decode+prefill `AnalyticsSeries` via `heroPoint` and calls `lensChart(..., { valueKeys: ["decodeTps", "prefillTps"], floorZero: true })`.
- `lensChart` (`apps/web/src/analytics.ts:78-139`) computes **one** domain from all series' finite values (lines 93-104: `Math.min(...finite)` / `Math.max(...finite)` plus `floorZero`/`domain`/`ceiling`) and uses it for every path: `sparklinePath(c.points, width, height, { min: yMin, max: yMax })` (line 129) and the exported `yMin`/`yMax` (line 138).
- `LensChart.vue` reuses the same domain for hover dots: `valueY(v)` uses `chart.yMin`/`chart.yMax` (LensChart.vue:25-28, applied to `rows` at the `<circle :cy="valueY(r.value)">`). Tooltips show **raw** series values (`charttip__value {{ fmt(r.value) }}`), independent of geometry.
- `sparklinePath` (`apps/web/src/sparkline.ts:48-80`) already derives its scale via `sparklineScale(points, domain)`; `sparklineScale` is exported and used per-series by `Sparkline.vue` — per-series scaling machinery exists, it is just not wired into `lensChart`.

Owner evidence (screenshot, DGX-1 GLM-5.3-Flash-EXL3): decode spikes to ~98 tok/s; prefill wiggles under ~2 tok/s and renders as a flat baseline on the shared 0–98 scale. Ask: independent scales.

Options:

| Option | Mechanism | Tradeoff |
|---|---|---|
| **A: per-series scale on `ChartSeries`** | `LensChartOptions.perSeriesScale?: boolean`; `lensChart` computes each series' own scale via the existing `sparklineScale` and stores it on the series; `sparklinePath` gets that domain; `LensChart` hover dots use the series' scale. Tooltips stay raw. | Additive optional field; every other chart untouched (opt-in). Hover-dot code touches two spots. |
| B: pre-normalized points | `heroSpark` maps each series to 0..1 before `lensChart` | Tooltip values become normalized numbers — wrong data in the `charttip`; rejected. |
| C: two stacked charts | One chart per metric in the hero card | Changes layout/height of the approved hero card; rejected. |

Option A details:

- `ChartSeries` gains `scale?: { min: number; max: number }` (`analytics.ts:29-34`); `analytics.ts` already imports from `./sparkline` (line 4-5) — add `SparklineScale`.
- Per-series rules: compute `sparklineScale(points, { floorZero: true })` per series (mirrors the shared `floorZero` opt). **Zero-pin rule:** if the series' finite values are all `0` (scale `min === max === 0`), override to `{ min: 0, max: 1 }` so the flat zero line renders at the **bottom**, matching today's shared-domain look (with `floorZero`, an all-zero series sits at `yMin = 0` today). A non-zero constant series keeps `sparklineScale`'s existing `±0.5` guard (flat line mid-chart — same semantics as the current shared behavior).
- Chart-level `yMin`/`yMax` become the union of the per-series scales (guides/markers are chart-level; `heroSpark` passes neither — a `perSeriesScale` chart must not pass `guides`/`markers`; documented, single call site).
- `LensChart.vue`: `rows` carry the series' `scale`; hover-dot `cy` uses it; path drawing passes the series scale as the `sparklinePath` domain.

Test impact (verified against the suites):

- `apps/web/test/overview.test.ts:82-90` pins "charts decode and prefill as two series over a shared zero-floored domain" — reworded/extended for per-series scales (the behavior changes by design).
- `apps/web/test/analytics.test.ts:26-37` "mixes metrics per series via valueKeys" — default (shared) mode regression, stays green.
- New analytics tests: per-series scale values (tiny prefill gets its own domain), zero-pin rule, union yMin/yMax, shared mode unchanged.
- `chrome-markup.test.ts:92+` pins `LensChart.vue` tokens (`charttip`, `@pointermove=`) — additive edits keep them.

Scope note: the node-page `LlmPanel` decode/prefill charts (llm-data.ts / LlmPanel.vue) are out of scope — the ask names the active-model card on the Overview. Opt-in flag keeps them shared-domain; adopting later is one option change.

## Summary of Findings

1. **Section swap** — move `OverviewView.vue:504-512` (h2 + nodes grid) above the fleet grid at 435; give the fleet grid `margin-top: 20px` (it keeps `margin-bottom: 12px`). No test or style collisions.
2. **Feed auto-scroll** — net-new `watch(feed)` + `nextTick` + `scrollTop = scrollHeight` on the `.log` ref. No existing scroll management to conflict with. Unconditional per the explicit ask.
3. **Per-series hero scale** — Option A: opt-in `perSeriesScale` in `lensChart`, per-series `sparklineScale` stored on `ChartSeries`, hover dots and paths use it, tooltips stay raw, all-zero series pinned to the bottom, chart-level yMin/yMax becomes the union. `overview.test.ts` hero pin updated; new analytics tests; other charts untouched.

Nothing remains open. All three changes are frontend-only (`apps/web`); no server/agent/core behavior changes.
