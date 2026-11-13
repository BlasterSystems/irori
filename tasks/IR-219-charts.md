# IR-219 — Charts under v1.1 idiom: LensChart labeled variant and Sparkline

- **Status:** Done (2026-11-13)
- **Type:** Feature (charts)
- **Jira:** [IR-219](https://blastersystems.atlassian.net/browse/IR-219) (sprint 1004, epic IR-214)

## Change

- `LensChart.vue` gains `labeled?: boolean`: a 44px y-label column with
  scale gridlines on `--rule` and compact mono 11px ink-3 labels, x labels
  (first / centered-middle / last, mono uppercase letter-spaced, middle
  `translateX(-50%)`), and legend swatches (14×8 line, dashed-aware).
  Bare mode renders byte-identical to before. Per-series-scaled charts skip
  the y column (a chart-level scale would lie); x labels + legend remain.
- Series palette fixed: `--ok`/`--warn` never existed as tokens (4th/5th
  series silently lost their stroke) — now thread/ink-2/ink-3/ink/
  thread-ink, keeping the shipped LensChart palette shape.
- `vector-effect: non-scaling-stroke` already ships on `.spark` and
  `svg[role=img]` strokes (IR-216 stylesheet); pinned by test.
- Width-aware rendering: `preserveAspectRatio="none"` + `width:100%`
  stretches the plot to the measured container — the established contract.
- Shared `.bs-legend` added to iroiri.css (OverviewView power legend and
  ported screens reuse it). The OverviewView power-chart pattern (ink bars
  0.5px/W, dashed thread window-average, dashed 240 W envelope) lands with
  IR-220 — it lives in that view.

## Acceptance

- [x] lens-chart-hover-ir84.test.ts: labeled-variant hover still works; y/x/legend assertions; per-series skip; vector-effect pin.
- [x] sparkline.test.ts green (Sparkline stays bare — untouched).
- [x] Full web suite green (508 tests).
