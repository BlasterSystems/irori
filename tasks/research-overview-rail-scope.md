# Research — Overview rail scope defect: hero + Nodes render outside the Main+Rail shell

Date: 2026-11-27 · Repo: `main` @ 79bb856 (deployed as `dev-0.7.0-32`) · Surface: `apps/web/src/components/OverviewView.vue` only · Trigger: owner report 2026-11-27 — "I am not seeing the vertical column being used as defined in the mockup".

## Tracker target

Project key **`IR`** · site **https://blastersystems.atlassian.net** · board 5 (per `docs/DEVELOPMENT_PROCESS.md` §9 + conventions verified in `tasks/research-feedback-round15.md`). No tracker named in this conversation.

## Summary

IR-282 (merged in PR #156, deployed as `dev-0.7.0-32`) shipped the Main+Rail shell with the **wrong scope**: only the Power card was wrapped into the shell. The serving hero and the Nodes grid render as full-width sections above it, so at full tier the page still reads as stretched full-width bands on top, and the rail column exists only beside Power — not "used as defined in the mockup", where main = hero → Nodes → Power and the rail runs the full height beside all three.

This is an implementation deviation from IR-282's approved composition (the ticket's own "Approved composition" section and the mockup both put hero + Nodes inside the main column); the mount test never pinned hero/Nodes placement, so the suite could not catch it. Fix is a structural move of two sections + spacing CSS + test updates. One Bug ticket.

## Current state (evidence)

| Fact | Evidence |
|---|---|
| Hero section renders BEFORE the shell | `apps/web/src/components/OverviewView.vue:649` (`<section … class="hero-grid section-gap" …>`) |
| Nodes h2 + nodes-grid render BEFORE the shell | `OverviewView.vue:686-694` (`<h2 class="h2-gap">Nodes</h2>`, `<section class="nodes-grid">`) |
| Shell opens after them; maincol holds ONLY Power | `OverviewView.vue:699-703` (`<div class="ov-shell" …><div class="maincol"><article …>Power`) |
| Approved composition: main = hero → Nodes 2×2 → Power; rail = token → NAS → caps → telemetry | `mockups/overview-adaptive.html:154` ("main column" wraps hero, `:178` ngrid-2, `:218` Power; `:238` `<aside class="rail">`); IR-282 description "Approved composition" (main column: serving hero → Nodes 2×2 grid → Power card) |
| Rail exists and is populated (not a rendering failure) | mount test `overview-main-rail-iri159.test.ts` green on main; served CSS contains `.ov-shell`/`nodes-grid` (verified post-deploy 2026-11-27) |
| Node cards at 2-across of 1296px ≈ 640px each — the "stretched" width the design targets at ~422px | `.nodes-grid` is a direct page child (full content width), `OverviewView.vue:693` |
| NetworkCard (IRI-163, merged after the mockup) renders full-width between Nodes and the shell | `OverviewView.vue:697`; diagram is an SVG with dynamic viewBox + `.netdiagram { width:100%; max-height:360px }` (`NetworkCard.vue:316,423`) — scales to its container |
| No open ticket covers this | JQL `project = IR AND statusCategory != Done AND (rail/overview/shell/column)` → only IR-273 epic (network topology, unrelated scope); IR-282 is Done |

Why the suite missed it: `overview-main-rail-iri159.test.ts` asserts "Power in `.maincol`" and the four rail surfaces, but never asserts that the hero or `.nodes-grid` are inside `.maincol`; the `ov-shell` implementation comment ("power keeps the main column") also encoded the wrong composition.

## Gap analysis

| # | Gap |
|---|---|
| G1 | Hero + Nodes outside the shell → no vertical column beside the top half of the page; node cards ~640px wide (design target ~422px); hero still a full-width band. |
| G2 | Rail starts beside Power → visually "unused" column; rail height (~4 cards) vs main column height mismatch is larger than designed. |
| G3 | NetworkCard landed (IRI-163) after the mockup — its placement must be decided relative to the shell (it did not exist when the composition was approved). |

## Proposed design

**D1 — Move hero + Nodes inside `.maincol`** (restores the approved composition):

- Template: move the hero `<section>` (+ its `v-else` ghost), the `<h2>Nodes</h2>`, the `.nodes-grid` section (+ ghost) to inside `<div class="maincol">`, before the Power article. Update the shell comment (`OverviewView.vue:688-692`) to the real composition.
- CSS: `.maincol` becomes `display: grid; gap: 16px; align-content: start; min-width: 0;`; keep `.maincol .section-gap { margin: 0 }` (spacing comes from the grid gap); zero the `Nodes` h2 margin inside maincol (`maincol` gap covers it). No change to `.ov-shell` columns, `ov-shell--flat`, or the ≤1100 stack (maincol then rail — heroes/nodes stack as today).
- Effect at full tier: main ≈856px (hero split tiles ~250px / chart ~700px as designed; node cards ~420px with ~170px bars); rail ≈428px beside hero→nodes→power.

**D2 — NetworkCard placement (decided at the gate; default = full-width below the shell)**:

- *Default*: move NetworkCard below the shell (before Updates). Zero width loss for the ring diagram (`viewBox` + `width:100%` scales down ~36% inside maincol; mono labels shrink with it); page order becomes Power-in-main | rail → Network → Updates — a coherent infra band. The rail then runs beside hero→nodes→power, i.e. the column is used from the top, which is the owner's actual complaint.
- *Alternative*: NetworkCard inside `.maincol` between Nodes and Power — rail starts at the very top beside the hero, but the diagram (the one surface, like Power's chart and Updates' table, that benefits from width) shrinks to ~820px.

**Rejected**: promoting the rail above the heroes or reflowing hero-grid to 2-up inside main when >1 hero (already handled by `ov-shell--flat` flattening the shell); CSS-only tricks (`position`/negative margins) — the sections genuinely belong inside the grid.

**ADR**: none — UI-local correction of a delivered design, no boundary moves.

## Phased delivery plan

One Bug ticket (High; repo work item next `IRI-<n>` — re-check at implement time; IRI-164 is consumed by the network live-mode work):

**Ticket: [IR-285] — "Overview: hero and Nodes render outside the Main+Rail shell" — created 2026-11-27 (Bug, To Do, High, backlog, assignee bruno@blastersystems.com). Gate decisions: NetworkCard below the shell (full-width, before Updates); hero + Nodes into .maincol.**

- **Bug (backlog)**: "Overview: hero and Nodes render outside the Main+Rail shell".
  Acceptance:
  - `.maincol` contains the hero section (or its ghost), the Nodes heading, `.nodes-grid`, and the Power card, in that order; `.rail` keeps token → NAS → caps → telemetry; NetworkCard per the gate decision (default: full-width below the shell, before Updates).
  - Full tier: node cards ≈420px, hero split preserved; ≤1100 stack order main→rail unchanged; small tier unchanged; `ov-shell--flat` still flattens when >1 hero.
  - Mount test extended: hero + `.nodes-grid` inside `.maincol` (this is the assertion that was missing); rail assertions unchanged; `overview.test.ts` source pin updated (maincol ordering).
  - `pnpm test` + `pnpm build` green; deploy web-bundle-only (next `dev-0.7.0-<n>`), probe `/api/v1/version` tag + served bundle contains the moved markup.

## Risks & open questions

1. **NetworkCard placement** is the one real decision (default: below the shell, full-width; alternative: inside maincol with a ~36% smaller diagram). Owner call at the gate.
2. Spacing normalization inside maincol (grid gap vs section-gap margins) is a visual QA point — the mockup used plain flow margins; grid gap is the cleaner equivalent but changes rhythm by a few px.
3. IR-198 ordering test (power < caps < updates) still holds under the new DOM order; verified by reading, re-confirmed by tests at implement.

## Overlap findings

Live JQL 2026-11-27: no open ticket matches (rail/shell/column/overview); IR-273 epic (network topology) is adjacent only via NetworkCard placement; IR-282 is Done — this is a defect against its approved composition, filed as a new Bug rather than reopening.
