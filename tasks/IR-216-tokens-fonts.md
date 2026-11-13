# IR-216 — Port DS v1.1 oklch tokens and fonts into apps/web

- **Status:** Done (2026-11-13)
- **Type:** Feature (theming)
- **Jira:** [IR-216](https://blastersystems.atlassian.net/browse/IR-216) (sprint 1004, epic IR-214)
- **ADR:** [ADR-0018](../docs/adr/0018-blasterystems-design-system-v1-1.md)

## Problem

`apps/web/src/assets/irori.css` carries the v1.0 hex-baked token blocks. DS
v1.1 is oklch with a much darker dark theme (paper #0e1217) and a revised
type scale. Working reference: `mockups/irori-v11.css` (verified verbatim).

## Change

- Token blocks replaced with the kit values verbatim (light default, OS-dark
  media query, explicit data-theme override; colors, type, spacing,
  effects). Header stamps provenance; never hand-tune oklch.
- Fira Sans 300 faces NOT copied: no ported rule sets weight 300 (manifest
  rule). 400/500/600 + DM Mono 400/500 stay.
- Irori-owned values ported: force-dark log console (--log-* from the v1.1
  dark palette: #0e1217/#eceff1/#2c3136/#8e9398; .ok #9cc29c ratified,
  .err #ee6a4a), DS table (th mono 11/400 no background, .num right mono
  tabular), glyph optical sizes (run/halt 9 base, 8 in chips; ok 8/7; warn
  8/7 outlined diamond), blur(12px) paper-2-92% topbar, underline .bs-field
  styles, ink .btn (44px) + quiet secondary inset ring, charttip paper-2
  surface without shadow.
- Existing class vocabulary kept (chip/dot/btn/card/...) so view churn
  stays inside the screen tickets; legacy aliases (--bg/--surface/...) map
  onto the v1.1 tokens.
- No elevation box-shadows: the only box-shadows left are inset
  rings/lines (borders). The v1.0 outer focus ring (0 0 0 3px) and charttip
  drop shadow are gone.

## Acceptance

- [x] Dark theme renders paper #0e1217 (oklch(0.18 0.012 255) — verified in the browser pass).
- [x] `pnpm --filter @irori/web build` + tests green (502 tests).
- [x] ds-markup/chrome-markup pins preserved (rewritten by IR-217).
