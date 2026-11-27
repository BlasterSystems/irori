# ADR-0022: Directional flow colour token for fabric traffic

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decision owners:** Owner (IR-286 implementation gate, 2026-11-27)
- **Scope:** UI colour tokens, data visualisation, Network card
- **Tags:** frontend, design-system, tokens, dataviz, network
- **Supersedes:** None
- **Amends:** [ADR-0018](0018-blasterystems-design-system-v1-1.md), for the flow colours only. ADR-0018 stays Accepted; see the amend rule in `docs/adr/README.md`.
- **Superseded by:** None

## Context

IR-286 animates RoCE traffic on the Overview Network card. Each cable is drawn as two lanes, one per direction. Lanes are coloured by **ring direction** (clockwise vs counter-clockwise), which is how NCCL ring collectives use the fabric. The owner approved the mockup (`mockups/IRI-171-network-card.html`): clockwise in the accent vermilion, counter-clockwise in blue.

ADR-0018 adopts DS v1.1 under these rules:
- oklch tokens are used verbatim and never hand-tuned;
- the palette is ink greys plus one accent, thread (vermilion);
- thread is used only as a line, live or warn state.

There is no second hue. Ink grey for the second direction reads as "inactive" next to a vermilion lane, so the two directions look unequal, not just different.

## Decision drivers

- Both directions are equally important data, so neither lane should look disabled.
- Direction must stay readable in both themes. Light is the default and dark follows the OS.
- Keep ADR-0018's monochrome-plus-thread character everywhere else.
- Direction must not depend on colour alone, for accessibility.

## Considered options

### Option 1: Stay within ADR-0018 (thread + ink-2)

Clockwise uses thread and counter-clockwise uses ink-2. This needs no token change. The cost is that the counter-clockwise lane reads as muted or idle, which misstates the data. The owner rejected this option.

### Option 2: One new directional colour, `--flow-ccw` (chosen)

Add one new hue, a blue `--flow-ccw`, defined in the light and dark blocks next to the DS tokens. Its use is restricted to directional traffic encoding. Clockwise keeps using thread through an alias, `--flow-cw: var(--thread)`, which fits ADR-0018's "line / live" use. That makes two custom properties, but only one new colour. This is the smallest deviation that makes both directions equal.

### Option 3: A full categorical chart palette

Add a 6–8 hue series palette for all charts. This is more than IR-286 needs, and it would change ADR-0018's "charts" decision broadly. It is deferred until a second need appears.

## Decision

Adopt Option 2:
- Add `--flow-cw: var(--thread)` and `--flow-ccw` to `apps/web/src/assets/irori.css`:
  - light: `oklch(0.52 0.14 255)`
  - dark (both the OS-dark media query and `data-theme="dark"`): `oklch(0.72 0.12 250)`
- `--flow-ccw` is used only to encode the counter-clockwise or reverse direction of traffic.
- It must never be used for status, actions, links or decoration.
- Direction is always encoded redundantly, by lane position (clockwise outer, counter-clockwise inner) and by arrows in the rate labels.

All other ADR-0018 rules stand unchanged:
- one filled button per surface;
- thread for warn and live;
- tokens verbatim.

## Consequences

### Positive

- Both directions read as equally live, and the ring-direction semantics are clear at a glance.
- The deviation is one token with a narrow, enforceable scope.

### Negative

- The UI gains a second hue. Future contributors may be tempted to reuse it for unrelated purposes.

### Risks and mitigations

- **Scope creep:** the risk is that the token gets used outside traffic direction. The mitigation is that the token's comment in `irori.css` names this ADR, and reviews refuse other uses.
- **Contrast:** both values must keep at least 3:1 non-text contrast against `--card` in their theme. Measured at implementation (WCAG relative luminance from the oklch values):

  | Colour | Light | Dark |
  |---|---|---|
  | `--flow-ccw` | 5.39 | 6.93 |
  | `--flow-cw` (thread) | 4.19 | 5.53 |

- **Clockwise and "down" share thread's hue.** Healthy clockwise traffic and a down link are both thread-coloured. The mitigation is that they never look alike:
  - a down link is a static dashed line with a "down" badge and no particles;
  - clockwise traffic is a faint solid track with moving particles, or a static solid line whose width follows the rate under reduced motion.
- **Other card fills stay on ink.** The Network card's load bar stays on ink (`--ink-2`), as before, because it encodes neither direction nor warning.

## Implementation and validation

IR-286 does the following:
- defines the tokens;
- uses them for lanes and rate arrows in `NetworkDiagram.vue`, and for the legend and table direction dots in `NetworkCard.vue`;
- includes a source test asserting the tokens exist in light and both dark blocks.

The owner's visual check happens on the dev deploy.

## Revisit triggers

- A second feature needs a categorical colour. In that case, design a full palette (Option 3) and supersede this ADR.
- A DS release ships its own data-viz palette.

## References

- ADR-0018 (amended), ADR-0021 (network topology)
- IR-286 / IRI-171, `tasks/research-network-card-motion.md`, `mockups/IRI-171-network-card.html`
