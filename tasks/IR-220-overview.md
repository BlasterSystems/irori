# IR-220 — Overview screen under DS v1.1 (tier machinery and all fleet states)

- **Status:** Done (2026-11-13)
- **Type:** Feature (screen skin)
- **Jira:** [IR-220](https://blastersystems.atlassian.net/browse/IR-220) (sprint 1004, epic IR-214)

## Change

- Skin (v1.1 values via the shared stylesheet): hero serving panels with
  17/600 titles + mono meta (12px ink-3), 6-stat grid, sparkline + legend
  swatches (decode thread / prefill ink-2); node panels with barrows; power
  and NAS panels; token tiles; forced-dark telemetry log; refresh-note
  footer (live status · cadence · fleet draw). Panel titles are 600
  app-wide (.card__head h3).
- Power chart: v1.1 labeled idiom — 44px y column (240/120/0), hairline
  grid, mono uppercase x labels (−range / now), legend entries for fleet
  draw (ink bar swatch), window average (dashed thread, live W) and the
  240 W per-node envelope (dashed ink-3, was border-strong).
- Tier machinery untouched: tiers.ts small ≤900 / medium / full, small-only
  fleet-temps card above heroes, select instead of seg below full, seg
  buttons only at full, hero sparkline hidden on small only.
- ALL states per IR-103 + round-3: **starting setups now render as heroes
  with the starting chip (round-3 MAJOR)**; stale (thread border, values
  0.75, labels keep contrast), unmanaged meta, node-down (error border +
  OFFLINE strip + dimmed body via NodeCard), no-temp-sensor dash rows
  sorted last, fleet-down cascade via the stale path — verified rendered.
- HealthBanner restyled into the v1.1 alert idiom (glyph column + title/
  body on hairline rules, no bordered box; severity keeps the
  banner--critical hook).
- Token tiles sanity: displayed cached is capped at the input total with a
  "capture gap" note (cache reads without a logged prompt could push the
  cache tile past input).
- 44px floors on real controls; 36px only on the range select at small
  width (approved tradeoff).

## Acceptance

- [x] overview.test.ts, overview-fleet-clock-ir198.test.ts, overview-shaped-ir84.test.ts green; starting hero has a rendered assertion.
- [x] health-banner-ir203.test.ts green (alert restyle, pins intact).
- [x] Full web suite green (509 tests).
