# ADR-0018: BlasterSystems design system v1.1 in Irori

- **Status:** Accepted
- **Accepted:** 2026-11-13 — owner directed implementation of epic IR-214 (sprint 1004); mockup round already owner-reviewed
- **Date:** 2026-11-13
- **Decision owners:** operator
- **Scope:** UI, theming, branding
- **Tags:** frontend, vue, design-system, blastersystems, branding, oklch
- **Supersedes:** [ADR-0005](0005-blasterystems-design-system-vue-port.md)
- **Superseded by:** None

## Context

The BlasterSystems design system moved to **v1.1** (identity v0.2, oklch
tokens): a much darker dark theme, a new app shell (232px paper-2 sidebar +
topbar), ink action buttons, underline form fields, a labeled chart idiom,
and a revised type scale. Irori still renders the v1.0 hex-baked skin pinned
by ADR-0005. The adoption was mocked first and owner-reviewed:
`mockups/irori-v11.css` plus `mockups/v11-{overview,serve,models}.html`
(round recorded in `mockups/PLAN.md`, "DS v1.1 adoption round", 2026-11-12;
verified in Chromium, both themes, 320–1568 no overflow, zero console
errors). Per repo ADR rules an Accepted ADR is superseded, never rewritten.

## Decision drivers

- DS v1.1 ground rules: oklch tokens verbatim (never hand-tune), paper
  `#0e1217` dark, no box-shadows, 2px control / 4px panel radii, ink action
  with one filled button per visible surface, thread (vermilion) only as a
  line / live / warn state.
- Irori keeps its information architecture: the skin changes, the IA carries
  over (approved density rounds + SPEC).
- Markup vocabulary strategy: keep Irori class names and change values (the
  ADR-0005 token-only port precedent); `bs-*` names appear only for
  genuinely new components (sidebar nav, fields, lockup).
- The kit is silent on some Irori needs; those stay Irori-owned.

## Considered options

### Option 1: Port DS v1.1 skin into the existing app (chosen)

Replace token blocks + component values in `apps/web/src/assets/irori.css`
from the verified mockup stylesheet, rebuild the shell (sidebar + topbar +
hamburger), restyle screens screen-by-screen. IA, routing, data tier
machinery, and tests carry over; contracts are rewritten where invalidated.

### Option 2: Stay on v1.0

No migration cost, but the org has moved; Irori would diverge from
BlasterSystems visual language and every future adoption compounds.

## Decision

Adopt DS v1.1 in Irori as follows:

- **Tokens**: oklch light + dark blocks verbatim (light default, OS-dark
  media query, explicit `data-theme` override; dark paper `#0e1217`).
  Type/spacing/effects from the v1.1 app subset (`--fs-*`, 44px hit floor,
  2px/4px radii, `--sidebar-width: 232px`).
- **Fonts**: Fira Sans 300 is available in the kit and recorded here; it
  ships only if a ported rule sets weight 300 (font-manifest rule — no dead
  weight). 400/500/600 Fira Sans + DM Mono 400/500 stay; latin + latin-ext
  woff2, self-hosted.
- **Shell**: 232px paper-2 sticky sidebar (brand lockup, nav, foot with
  live status + version/deploy tag) + sticky topbar (page actions, theme
  toggle, hamburger at 900px and below). Primary nav moves into the
  sidebar; nav counts are totals only. This supersedes the IR-197 footer
  placement: version/watts live in the sidebar foot and the refresh-note;
  the deploy tag keeps its committed hamburger-menu home (IR-197 B1).
- **Components**: ink `.bs-btn` action buttons; one filled button per
  visible surface (page chrome carries one; each owned modal/drawer
  carries one); destructive actions are thread-ink text links; underline
  `.bs-field` fields (toolbar search/select keep the bordered hybrid);
  panels on card surface with 1px rule borders; no box-shadows anywhere.
- **Charts**: labeled variant (44px y-label column, hairline grid on
  `--rule`, mono uppercase x labels, legend swatches); hero sparklines
  stay bare; `vector-effect: non-scaling-stroke` everywhere.
- **Irori-owned where the kit is silent**: force-dark log console
  (`--log-*` from the v1.1 dark palette; `.ok` green `#9cc29c` carried from
  v1.0, ratified — contrast 9.49 on the forced-dark surface; `.err`
  `#ee6a4a` v1.1 dark thread), DS-styled data tables (mono uppercase th,
  hairline rows, right-aligned mono numerics), 300px button-anchored info
  tips opening rightward.
- **Data tiers**: keep `src/tiers.ts` (small ≤900 / medium / full) and add
  the v1.1 media tiers (600/900/1100) alongside.

## Consequences

### Positive

- Verified parity with the org DS v1.1; single oklch source for both themes.
- Dark theme finally matches the kit's near-black paper; ink action reads
  as the primary affordance.

### Negative

- One-shot restyle across ~20 views; contract tests must be rewritten with
  the shell/screen tickets or the suite lies.

### Risks and mitigations

- Token hand-tuning drift → values are copied verbatim from
  `mockups/irori-v11.css` (itself verified against the kit) and the
  stylesheet header stamps provenance; never hand-tune oklch.
- Mixed-skin intermediate states → tokens/components land first, screens
  follow as child tickets, and IR-223 sweeps every remaining route before
  the epic closes.

## Implementation and validation

Children IR-216 (tokens/fonts) → IR-217 (shell) → IR-218 (components) →
IR-219 (charts) → IR-220/221/222 (mocked screens) → IR-223 (remaining
screens). Validation per epic IR-214 acceptance: `.agentic/bin/validate`,
`.agentic/bin/docs-check`, `pnpm --filter @irori/web build` + tests, dark
paper `#0e1217`, overflow sweep 320→1568 on every route, a11y contract
(aria-pressed chips, focus-managed drawer, 44px floors), zero console
errors in the browser pass.

## Revisit triggers

- DS v1.2 with token renames → regeneration pass over the token blocks.
- The transfers-surface options round (IRI-048) resolves → the Transfers
  surface port lands under the chosen shape.

## References

- Epic [IR-214](https://blastersystems.atlassian.net/browse/IR-214) and
  children IR-215…IR-223 (sprint 1004)
- `mockups/PLAN.md` "DS v1.1 adoption round"; `mockups/irori-v11.css`
- Kit: `~/Developer/BlasterSystems design system v1.1/` (tokens verbatim
  source; identity v0.2)
- Superseded: [ADR-0005](0005-blasterystems-design-system-vue-port.md)
