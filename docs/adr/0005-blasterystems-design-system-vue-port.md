# ADR-0005: BlasterSystems design system, Vue 3 port (uptime-monitoring recipes)

- **Status:** Superseded
- **Accepted:** 2026-10-19 — owner approval after M1–M7 shipped on these decisions
- **Date:** 2026-10-16
- **Decision owners:** operator
- **Scope:** UI framework, visual language, theming, branding
- **Tags:** frontend, vue, design-system, blastersystems, branding
- **Supersedes:** None
- **Superseded by:** [ADR-0018](0018-blasterystems-design-system-v1-1.md) — DS v1.1 (oklch identity v0.2, sidebar shell, ink action) replaces the v1.0 hex-baked token port

## Context

Irori's UI must use the **BlasterSystems design system** (`~/Developer/
BlasterSystems - design system`, oracle `Design System.dc.html`) and follow
the same branding logic as `uptime-monitoring` (thread mark ○—■ + product name
+ DM Mono "A BlasterSystems product" endorsement, ink-tile favicon). The
uptime-monitoring web app already contains a faithful, token-only Vue 3 port:
hex-baked OKLCH tokens with a 3-block theme mechanism, self-hosted Fira Sans /
DM Mono woff2, a 30×10 `.brand-mark` lockup, and 19 token-only ui components.

## Decision drivers

- DS ground rules: ink/paper only; the thread line is the only vermilion; no
  shadows; 2px control / 4px panel radii; states are shapes first.
- The brand lockup and token machinery must be byte-consistent with the
  sibling product (same org, same visual language).
- The four source dashboards are React — but their UI code is not required;
  only their information architecture is.

## Considered options

### Option 1: Vue 3 + Vite, port uptime-monitoring's DS recipes (chosen)

Copy the `@font-face` block + hex token blocks (3-theme pattern) + semantic
aliases + `.control` styles; re-implement the ui component set as variant-union
SFCs over tokens; brand lockup = `.brand-mark` spans (thread line only
vermilion) + "Irori" Fira Sans 600 + mono caps endorsement; favicon = ink tile
+ paper ○■ + vermilion line. Fastest path to a verified-faithful UI.

### Option 2: React 19 (sparkDash heritage)

Maximal reuse of source-project components, but imports the DS-incompatible
styling of those projects and abandons the proven token port.

### Option 3: Server-rendered templates

Lightest, but live telemetry dashboards need a reactive client; SSE + fine-
grained updates are natural in Vue.

## Decision

Option 1. Concretely: self-hosted `fira-sans-latin-{400,500,600}.woff2` +
`dm-mono-latin-{400,500}.woff2`; `:root` / OS-media / `[data-theme=dark]`
token blocks with DS OKLCH baked to sRGB hex; semantic aliases
(`--bg/--surface/--fg/--muted/--accent…`); body 15px (denser than DS 17 for
app density); ui components: Button, Badge, Card, Field, Input, Select,
Textarea, Switch, Table, Tabs, Modal, ConfirmDialog, EmptyState, CodeBlock,
Spinner, Icon, Toast + hand-rolled charts. Product name **Irori**; localStorage
key `irori-theme`; pre-paint inline theme script.

## Consequences

### Positive

- Verified visual parity with the org DS; zero runtime style deps.
- Charts and data-dense tables follow the DS data-row/mono conventions.

### Negative

- Vue instead of React — no component reuse from the four source projects.

### Risks and mitigations

- DS drift → the `.dc.html` oracle is versioned in its repo; tokens are
  generated once and reviewed against it (skill:
  `blastersystems-ds-mark-generation`).

## Implementation and validation

M1 ports tokens/fonts/lockup/theme + base components. Validation: visual
review light/dark against the DS (browser screenshots); component tests;
theme-persist test.

## Revisit triggers

- DS v2 with token renames → regeneration pass.

## References

- SPEC §1.6; PLAN M1; `Design System.dc.html` §§01–08;
  `uptime-monitoring/apps/web/src/style.css`, `layouts/AppLayout.vue`.
