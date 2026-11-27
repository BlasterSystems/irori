# Research: Network card — traffic motion, label declutter, two-column layout

## Tracker target

Jira project **IR** via the project `mcp-atlassian` server (resolved from existing `tasks/IR-*.md`, recent commit subjects `IR-285 / IRI-169`, and the IR-273 epic). Local id: **IRI-171** (IRI-170 is taken by `tasks/IRI-170-remove-omp-refract-hook.md`). Jira key: **IR-286** (created 2026-11-27 after owner approval; relates to IR-277).

## Summary

The owner called the shipped Overview Network card (IR-277 / IRI-163) "a really good starting point" and gave three notes:

- They want to see **movement**, for example simulated traffic.
- The **text painted on the connecting lines** doesn't help them understand what's going on.
- The **empty space** around the diagram looks odd.

A PM review and a UX review agreed on one front-end-only story:

- Remove all text from the edges.
- Show the format string once in the header.
- Draw each cable as two animated directional lanes, driven by real per-direction rates on a log scale, with honest idle, stale and down states.
- Compose the diagram and the link list side by side.

Mockup: `mockups/IRI-171-network-card.html`. It has scenario, tier and motion toggles, and simulated data.

## Current state (evidence)

- Edge labels are two `<text>` rows centred on every edge midpoint: the format, then ↑/↓ rates and RTT. A 4 px surface-colour stroke halo makes vertical edges look cut (`apps/web/src/components/NetworkCard.vue:330-341`, `.netlabel` at `:425`).
- The format string is the same on all four links and is repeated in the table's Format column (`NetworkCard.vue:359`, `:369`; `linkFormat` at `apps/web/src/network.ts:83`).
- ↑/↓ are relative to the link's arbitrary endpoint `a` (`NetworkCard.vue:279-283`, "tx = a → b"), so direction is ambiguous on the diagram.
- Layout:
  - The diagram has a fixed `720×340` viewBox placed on an ellipse (`network.ts:59-75`).
  - The diagram is `width:100%; max-height:360px` (`NetworkCard.vue:423`).
  - The card renders full-width below the Main+Rail shell (IR-285). The result is a centred island with wide side gutters and the table below it.
- The utilisation bar is linear against 400G (`utilPct`, `network.ts:102`). At today's 5–7 Gb/s it renders as a dot.
- The 24 h sparklines are **real per-link history**, from `GET /api/v1/network/links/:id/history` (`network.ts:275-288`). Their similar shapes plausibly reflect the TP ring's symmetric load. [INFERENCE: verify against the dev hub during implementation.]
- Rates already take the larger of the RDMA and kernel counters (card Tip, `NetworkCard.vue:300`). Idle on the card is therefore trustworthy during NCCL runs.
- Freshness:
  - Live frames carry `receivedAtMs` and `intervalMs`, and are dropped after `3×interval + 1 s` (`network.ts:185-196`).
  - The 2 s snapshot path has no stale guard on the card today. [INFERENCE: `HardwareSnapshot` carries a timestamp. Confirm during implementation.]
- Reduced motion: the global `prefers-reduced-motion` rule zeroes CSS animation durations (`apps/web/src/assets/irori.css:115`). A rAF/JS-driven animation must check it itself.
- Small tier hides the diagram completely (`NetworkCard.vue:437`).

## Gap analysis

| Owner note | Cause | Fix |
|---|---|---|
| No movement | Static lines; numbers only | Two lanes per cable with particles; speed, density and opacity follow log(rate) |
| Text on lines confuses | Two text rows on each edge midpoint; identical format string; "a"-relative arrows | No text on edges. Rate pills sit inside the ring, with arrows matching the geometry. Format goes in the header. Deviations become edge badges. |
| Odd empty space | Fixed wide ellipse, full-width card, table stacked below | Two-column grid: compact ring (5fr) and link list (7fr). The ring interior holds the pills. |

## Proposed design

What the mockup shows:

1. **Header**
   - "Network" plus a mode badge: `snapshot · 2 s`, `live · 1 s` or `stale · N s`.
   - A subtitle: `RoCE fabric · 4 links · every link RoCE v2 · 200G ×2 · MTU 9000`. When links differ, it reads "mixed" and the deviating link shows its own badge.
   - Controls are unchanged, except "Test all fabric links" is renamed "Test all links" and "Live off"/"Live" becomes "Go live"/"Stop live".
2. **Diagram (left column)**
   - Square ring with compact tiles (132×50). Cluster members get an accent outline and an accent role.
   - Each cable is two lanes, offset ±5 px. Lanes are coloured by **ring direction**:
     - clockwise: accent orange, outer lane
     - counter-clockwise: blue, inner lane
   - Ring direction is meaningful for NCCL ring all-reduce and removes the "a vs b" ambiguity.
   - Particles: a dash pattern advanced by rAF.
     - `t = log10(bps/1 Mb/s) / log10(400 Gb/s / 1 Mb/s)`, clamped to 0–1
     - speed = 18 + 150·t px/s
     - gap = 26 − 18·t
     - opacity = 0.35 + 0.65·t
     - Speed eases about 600 ms toward each new sample.
     - Opacity is ×0.75 in snapshot mode.
   - States:
     - idle (below 1 Mb/s): faint track only, no particles
     - stale or no data: dashed grey, no motion, pill reads "no data"
     - down: dashed red, no motion, "down" badge
     - degraded: `1/2 lanes` badge
     - MTU mismatch: `MTU ≠` badge
   - Rate pills sit inside the ring, next to their edge, never on a line. They hold two lines, with arrows that match the geometry (→/←, ↓/↑) and are coloured by direction.
   - Below the ring: a legend (clockwise / counter-clockwise / no data / down / "motion ∝ log rate") and the running-cluster line.
3. **Link list (right column)**
   - Link (with lanes and any deviation)
   - Traffic: two named directions, e.g. `DGX-1 → DGX-2 6.8 Gb/s`, with direction-colour dots
   - Load: a log-scale bar with % of 400G
   - RTT · loss
   - 24 h sparkline
   - Test button, with the last result underneath
   - The Format column is dropped.
4. **Linking**: hovering or focusing an edge, a tile or a row highlights the others and dims the rest. Hovering an edge shows a tooltip with format, both rates, RTT, loss, lanes and last test. Rows are keyboard-focusable.
5. **Responsive by the card's own width** (owner follow-up 2026-11-27: "make sure that overflow doesn't happen and the card is adjustable, moving the table below the animation for example"). The card is a CSS container (`container-type: inline-size`), so the layout follows the card, not viewport tiers:
   - **≥ 1280 px**: ring on the left (380–460 px). On the right, a 4-up summary strip (Health, Fabric total, Busiest direction, Worst RTT), then legend and cluster, then the table.
   - **≤ 1279 px**: the **table moves below the animation**. The ring sits beside a 2×2 summary with legend and cluster; the table runs full-width underneath.
   - **≤ 820 px**: the table drops the 24 h and Load columns. The ring already shows load.
   - **≤ 700 px**: single column. Ring (max 460 px), 4-up summary strip, then the table.
   - **≤ 600 px**: phone. Rows become cards, pills are hidden (badges kept), tile text is larger, and the header stacks.
   - The Test result caption wraps onto two lines instead of forcing width. The list has `overflow-x: auto` as a last-resort guard that no layout should need.
   - Verified in the mockup by an automated sweep: 4 scenarios × card widths 340–1600 px in 10 px steps. No element leaves the card and the list never scrolls.
6. **Motion hygiene**: pause rAF when the tab is hidden or the card is off-screen (IntersectionObserver). `prefers-reduced-motion` switches to static encoding: lane width 1.5–4 px and opacity by `t`.

Rejected alternatives:

- **CSS `stroke-dashoffset` keyframes per edge.** Speed changes jump, because changing the duration restarts the cycle. rAF is about 8 path updates per frame, which is negligible.
- **Particles coloured by endpoint `a`/`b`.** These are meaningless to the owner. Ring direction maps to how NCCL uses the fabric.
- **Keeping rates on the diagram only on hover.** The PM preferred glanceable numbers, and the empty ring interior is the right place for them.
- **Linear utilisation.** At under 2 % of 400G it is invisible.

No ADR is needed: this is presentation inside an existing component, with no data, API or dependency change.

## Phased delivery plan

One story, **IR-286 / IRI-171: Network card — directional traffic motion, decluttered labels, two-column layout** (front-end only, follow-up to the IR-273 epic).

Acceptance criteria:

- [ ] No text is drawn on or over an edge line. The format string appears once in the card subtitle, and per link only as a deviation badge (MTU mismatch, lane loss) or in the tooltip and table.
- [ ] Each cable renders two direction lanes coloured by ring direction (clockwise or counter-clockwise from `ringOrder`), with rate pills inside the ring whose arrows match the edge geometry. Links outside a ring (n ≤ 2, switched subnets) fall back to `a → b` for "clockwise".
- [ ] Particle speed, density and opacity follow the documented log mapping of the **real** per-direction rate, and ease between samples. There are no particles below 1 Mb/s and no motion when data is stale (older than about 2.5× the sample interval), the node is offline, or the link is down. Each of those states looks distinct.
- [ ] `prefers-reduced-motion` gives static width and opacity encoding. Animation pauses when the tab is hidden or the card is off-screen.
- [ ] The header mode badge shows `snapshot · 2 s`, `live · <rate>` or `stale · N s`.
- [ ] The layout follows the card's own width (container queries, breakpoints 1280 / 820 / 700 / 600 as in the design): side by side when wide, **table below the animation** under 1280 px, columns dropped under 820, single column under 700, cards under 600. Nothing overflows the card at any width from 340 to 1600 px. A test pins this, for example a mount test per breakpoint asserting `scrollWidth <= clientWidth`.
- [ ] A summary (Health, Fabric total, Busiest direction, Worst RTT) sits beside or above the ring, so the space next to the diagram carries information.
- [ ] The table drops the Format column, names both directions (`A → B`, `B → A`), uses a log-scale load bar, and shows the last test result under Test.
- [ ] Hovering or focusing an edge, tile or row cross-highlights the others. The edge tooltip lists format, both rates, RTT, loss, lanes and last test.
- [ ] Unit tests cover the intensity mapping, ring-direction orientation and the stale/idle/down state derivation. Mount tests cover the no-text-on-edge rule, deviation badges and hover linking. `pnpm test` and `pnpm build` are green. The change is deploy-affecting for the web bundle only.

## Risks and open questions (with proposed defaults)

1. **Owner wording**: "the text on top of the connecting lines does help understanding" is read as "doesn't help". _Default: remove it, as mocked._
2. **Lane colours**: orange for clockwise and blue for counter-clockwise introduces a second hue. _Default: keep. It is the clearest direction cue, and blue is not used for status._
3. **Small tier**: re-show the diagram, reversing the IR-128 rule. _Default: yes, compact and without pills._
4. **Snapshot staleness**: needs a snapshot timestamp on the client. _Default: use it if present; otherwise derive from the SSE receive time (front-end only either way)._
5. **Rename "Test all fabric links" to "Test all links"**. _Default: yes; the header already says "RoCE fabric"._

## Overlap findings

A Jira search (`project = IR AND text ~ network|fabric|topology`) returned the IR-273 epic and all its stories (IR-274…IR-283), all **Done**. There is no open ticket on the card's presentation. IR-285 (Done) placed the card full-width below the shell. This story keeps that placement and fixes the composition inside the card. Proposed link: "relates to" IR-277 (the card story).
