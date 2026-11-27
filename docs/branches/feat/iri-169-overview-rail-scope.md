# Branch: feat/iri-169-overview-rail-scope (IR-285)

## Business context

IR-282 shipped the owner-approved Overview Main+Rail redesign with the wrong scope: only the Power card was wrapped in the shell, so the serving hero and the node cards kept rendering as full-width bands above it and the rail column sat unused beside Power. The owner reported it live on `dev-0.7.0-32` (2026-11-27). Research: `tasks/research-overview-rail-scope.md`.

## What changed

- The serving hero section and the Nodes 2-col grid (plus their empty-state ghosts and the Nodes heading) render inside the shell's main column, before Power — the approved composition (hero → Nodes → Power in main; token stats · NAS store · clock caps · telemetry in the rail, full height).
- The Network card moved below the shell (full-width, before Updates) — owner gate call; the RoCE ring diagram keeps its width.
- Main-column spacing is grid-gap based (16px) with tier-scoped margin resets; the small tier gets the same treatment, which also fixes a pre-existing small-tier double-space in the rail.
- Full tier: node cards land ≈420px wide instead of ≈640px.

## Business rules and constraints

- Updates stays full-width (table needs ≥640px); the shell still flattens when more than one process serves (`ov-shell--flat`) and still stacks main→rail at ≤1100px.

## Edge cases handled

- Empty states (nothing serving / no spark nodes) render as gap-spaced ghosts inside the main column.
- The small-tier rhythm rule (more specific selectors) would have re-added margins inside the grids; tier-scoped resets neutralize it at every tier.

## Integration impact

None outside the web bundle. No API, schema, or agent change.

## Out of scope and follow-ups

- README overview screenshot still shows the pre-IRI-159 layout (pre-existing follow-up from IR-282).
- Cosmetic: the Power article block kept its pre-move indentation.

## Verification

- `pnpm test`: all workspaces green — web 70 files / 581 tests (incl. the new placement assertions), core 138, proxy 24, agent 391, server 366 passed / 188 env-skipped, db 8 passed / 8 skipped.
- `pnpm build`: green.
- Mount-level placement pins: hero ghost + `.nodes-grid` inside `.maincol`; real hero (running + detected engine) inside `.maincol` with the flattened shell; single starting hero keeps `hero-grid--single` and no flat; Network card asserted outside `.ov-shell`; source pins fix the maincol ordering and Network-below-shell.
- Security-check PASS (template/CSS/test-only diff); independent adversarial review: PASS WITH FINDINGS (2 INFO, 0 WARN/BLOCK; INFO-1 resolved, INFO-2 cosmetic accepted).

## Changelog

- 2026-11-27 — Overview: hero and Nodes render inside the Main+Rail shell; Network card below it; gap-based main-column spacing; placement tests (IR-285 / IRI-169).
