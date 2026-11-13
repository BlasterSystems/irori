# IR-215 — ADR: adopt BlasterSystems DS v1.1 in Irori (supersedes ADR-0005)

- **Status:** Done (2026-11-13)
- **Type:** Docs / ADR
- **Jira:** [IR-215](https://blastersystems.atlassian.net/browse/IR-215) (sprint 1004, epic IR-214)

## Problem

ADR-0005 (Accepted 2026-10-19) pins the v1.0 hex-baked token port. Epic
IR-214 adopts DS v1.1 (oklch identity v0.2, darker dark, sidebar shell, ink
action, underline fields). Accepted ADRs are superseded, never rewritten.

## Change

- `docs/adr/0018-blasterystems-design-system-v1-1.md` — status Accepted
  (owner directed sprint implementation), Supersedes ADR-0005, scope
  UI/theming/branding.
- Decision content: oklch tokens verbatim (dark paper #0e1217), 232px
  paper-2 sidebar shell with 900px hamburger, ink action with one filled
  button per visible surface, destructive as thread-ink text links,
  underline fields, Irori-owned log console/tables/300px tips, log syntax
  colors ratified (.ok #9cc29c carried, .err v1.1 dark thread).
- Font record: Fira Sans 300 available in the kit; ships only if a ported
  rule sets weight 300 (manifest rule).
- ADR-0005 marked Superseded with the link; index updated.

## Acceptance

- [x] ADR-0018 merged with status Accepted, index row added, ADR-0005 gains "Superseded by: ADR-0018".
- [x] docs-check green.
