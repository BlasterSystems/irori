# Branch: feat/iri-171-network-card-motion (IR-286)

## Business context

The owner reviewed the shipped Overview Network card (IR-277) and called it "a really good starting point", with three notes:
- they want to see movement, such as traffic;
- the text painted on the connecting lines didn't help;
- the empty space around the diagram looked odd.

After the mockup review, they also asked that the card never overflow and adapt to its width, for example by moving the table below the animation. Research: `tasks/research-network-card-motion.md`. Mockup: `mockups/IRI-171-network-card.html`.

## What changed

- **Traffic motion.**
  - Each RoCE cable is drawn as two lanes, one per direction, coloured by ring direction: clockwise in the accent, counter-clockwise in blue.
  - Particles move at a speed and density that follow a log scale of each direction's real rate, from 1 Mb/s to 400 Gb/s.
  - Idle, stale, offline and down links never move, and each looks different.
- **No text on the lines.**
  - Rates sit in small labels inside the ring.
  - Problems show as badges beside the cable: lane loss, MTU mismatch, down.
  - The shared format ("RoCE v2 · 200G ×2 · MTU 9000") is stated once under the card title.
- **Summary panel:** Health, Fabric total, Busiest direction, Worst RTT.
- **Link table:**
  - names both directions, for example "DGX-1 → DGX-2 6.8 Gb/s";
  - has a log-scale load bar;
  - shows the last test result under Test;
  - no longer has a Format column.
- **Layout follows the card's own width:**
  - side by side from 1280 px;
  - table below the ring under 1280;
  - fewer columns under 820;
  - single column under 700;
  - row cards under 600.

  It never overflows, and phones show the ring again.
- **Hover links the views:** hovering a cable, a node or a table row highlights the matching ones. Rows are keyboard-focusable, and a tooltip on a cable shows its details.
- **Header badge:** shows `snapshot · <hub cadence>`, `live · <rate>`, or `stale · N s`.

## Business rules and constraints

- **Data freshness** is judged by when this page received each sample: snapshots, and live frames while Live is on. Each is judged against its own cadence (the hub's `cadenceMs` or the Live interval), never against agent clocks.
- **Motion honesty:**
  - no particles below 1 Mb/s;
  - no motion when stale (older than 2.5 sample intervals), offline or down;
  - a reduced-motion preference shows static line widths instead;
  - animation pauses when the tab is hidden or the card is off-screen, and stops entirely when nothing moves.
- **Colours:** ADR-0022 adds one direction colour to the design system and amends ADR-0018 for that alone. It is used only for traffic direction.

## Edge cases handled

- Live on while an agent sends no live frames (an old agent or a lapsed lease), or a single late frame: judged from snapshots, with no false "stale".
- Rings of 3 or 5 nodes: badges and labels clear both lanes on diagonal edges.
- A fabric of switched subnets only: node tiles still render.
- Links whose topology "a" end runs counter-clockwise: rates are swapped into ring direction.
- Light and dark themes.

## Integration impact

Web bundle only. The live store records snapshot receipt times, an additive client-side change. No API, schema or agent changes.

## Out of scope and follow-ups

- Edges and tiles are hover-only; the keyboard path is the table rows. Owner decision pending: whether to make them focusable.
- The README Overview screenshot is still pre-IRI-159.
- Two Overview mount tests have a pre-existing cold-start cost (about 2 s), which can exceed 5 s under parallel load.

## Verification

- **`pnpm test`:** green.
  - web: 602 tests, including 34 Network card tests
  - core: 138
  - proxy: 24
  - agent: 391
  - server: 366 passed, 188 env-skipped
  - db: 8 passed, 8 skipped
- **`pnpm build`:** green. The CSS bundle contains `--flow-ccw`.
- **Real-browser sweep** of the actual component, against dev-hub data:
  - no overflow at 127 card widths from 340 to 1600 px, in dark and light;
  - lanes animate under load, pause off-screen and stop when idle.
- **Security check:** PASS.
- **Independent adversarial review:**
  - round 1: BLOCK, now fixed;
  - round 2: PASS WITH FINDINGS. The low findings are fixed; the keyboard deviation is recorded.

## Changelog

- 2026-11-27: Network card shows directional traffic motion, has no text on edges, adds a summary and lays out by its own width; ADR-0022 flow colour; snapshot receipt times in the live store (IR-286 / IRI-171).
