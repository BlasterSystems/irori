# Research — Collapsed rail: Add node button size/alignment (owner feedback, round 13)

Date: 2026-11-15 · Skill: `research` (no code; epic/stories only after the gate)

**Filed:** gate approved 2026-11-15 → **[IR-249](https://blastersystems.atlassian.net/browse/IR-249)** (Task 10024, parent IR-237, sprint 1004 "IR Sprint 4", assignee Bruno Pires). Research doc posted as IR-237 comment 26078.

## Jira target

Resolved live 2026-11-15 (probe, not memory):

| Item | Value | How resolved |
|---|---|---|
| Project key | `IR` (Irori) | Repo artifacts: every `tasks/IR-*.md` references `blastersystems.atlassian.net/browse/IR-*`; `AGENTS.md` fixes the `IRI-<n>` task convention. No in-repo jira-manager skill exists (`.claude/skills/` holds only research/implement/semantic-versioning/architecture-decision/docs-check/agentic-bootstrap). Cross-checked against managed skill `mwa-jira-rest` (site 3 = IR on blastersystems). |
| Site | `https://blastersystems.atlassian.net` | same |
| Board | id **5** "IR board" (simple) | `GET /rest/agile/1.0/board?maxResults=50` filtered on `location.projectKey === "IR"` → single hit |
| Issuetype ids | Subtask 10020 · Epic 10021 · Story 10022 · Bug 10023 · Task 10024 | `GET /rest/api/3/issue/createmeta?projectKeys=IR&expand=projects.issuetypes` re-probe 2026-11-15 |
| Active sprint | **1004 "IR Sprint 4"** (2026-11-08 → 2026-11-15T20:52Z) | `GET /rest/agile/1.0/board/5/sprint?state=active` — ends today; fleet rolls to the next sprint |
| Assignee | `<redacted-jira-account-id>` (Bruno Pires) | `GET /rest/api/3/myself` |

## Summary

Owner feedback (screenshot, deployed hub): in the collapsed rail the **Add node (+) button is not the same size** as the other rail controls and reads **pushed left**. Verified on the deployed artifact: the button keeps the **menu-tier full-width box (51×36)** instead of collapsing to the **36×36 bordered square** the range trigger uses; its wider box's left edge sits ~7.5px left of the icon column, which reads as "aligned left / oversized". The + glyph itself is already on the shared center axis — only the box is wrong. One-ticket CSS fix in the app **plus the same fix in the approved mockup** (the defect is inherited from the mockup, same as the round-10 S-A precedent).

## Current state (evidence, file:line)

Markup — `apps/web/src/App.vue:265-267` (sidebar tools block, inside `.bs-sidebar__tools` at :252):

```html
<button class="btn btn--secondary btn--sm" type="button" title="Register a node and install the agent" @click="addNodeOpen = true">
  <BsIcon name="plus" /><span class="tools-cta-label">Add node</span>
</button>
```

CSS — `apps/web/src/assets/irori.css`:

- :291 `.btn { display:inline-flex; align-items:center; gap:…; min-height:44px; padding:0 18px; … }`
- :300 `.btn--sm { min-height:36px; padding:0 14px; … }` — **no width cap anywhere**
- :181 `.bs-sidebar__tools { display:flex; flex-direction:column; … }` — a flex **column**, so the button stretch-fills the cross axis (default `align-items: stretch`)
- :213 collapsed `… .bs-sidebar__tools { padding-left:8px; padding-right:8px; }` → content width 68−16 = 52px
- :215 collapsed `… .bs-sidebar__tools .btn { justify-content:center; padding:0; }` — centers the *content* but cannot shrink the *box*
- :231 `.iconbtn { … width:36px; height:36px; … }` — the range trigger inside `.rangeseg-pop` (centered by :214 `display:flex; justify-content:center`)

Measured in a real browser on the **deployed hub** (`http://10.20.30.9:3947`, tag `dev-0.7.0-21` — contains IR-238, i.e. exactly what the owner screenshotted), 1568×961, collapsed:

| Element | box x | box w×h | center x |
|---|---|---|---|
| Rail (`.bs-sidebar`) | 0 | 68×961 | 34 |
| **Add node `.btn`** | **8** | **51×36** | 33.5 |
| Range `.iconbtn` (clock) | 15.5 | 36×36 | 33.5 |
| Nav icon (`.bs-icon`) | 24.5 | 18×18 | 33.5 |
| + glyph inside the button | 24.5 | 18×18 | 33.5 |

→ Glyph is on the shared 34px axis (IR-238's axis survived); the **box is 15px wider** than the icon squares and sticks 7.5px past the icon column on each side — next to the 36px clock button directly above it, the + reads oversized and left-shifted.

Root cause: IR-238 (commit `3a1372a`) fixed the brand/chevron/popover-trigger centering but **never capped the Add node button width** — `justify-content:center; padding:0` alone can't un-stretch a flex-column item.

Mockup (approval surface) — same defect, inherited:

- `mockups/v14-round8.html:82-85` — same structure (`bs-btn bs-btn--secondary bs-btn--sm` + icon + `bs-btn__label`)
- `mockups/irori-v14.css:35` — `… .bs-sidebar__tools .bs-btn { justify-content:center; padding:0; }` — same missing width cap; base `.bs-btn--sm { min-height:36px; padding:0 14px }` comes from `irori-v11.css:247` via the `@import "irori-v11.css"` at `irori-v14.css:14`
- Measured mockup (`file://…/v14-round8.html`, collapsed forced): **identical** — box x=8, 51×36, glyph cx 33.5, clock 36×36 at x=15.5

So the owner has now overridden the approved mockup geometry; per the round-10 precedent ("inherited from the mockup — fix the mockup too"), both surfaces change in one ticket.

## Gap analysis

Intended geometry (the rail's bordered-square idiom): the collapsed rail shows exactly one bordered square shape — 36×36 (`--control-sm: 36px`, `irori.css:68`) — the range trigger. The Add node button already has the right **height** (36 via `.btn--sm`) and the right **glyph axis**; the only gap is **box width + horizontal centering of the box**. Matching the range trigger exactly makes the two tools a matched pair of 36px squares on the axis.

## Proposed design

**Decision** — in the ≥901 collapsed block (`apps/web/src/assets/irori.css`, inside `@media (min-width: 901px)`), replace rule :215 with a capped, centered square:

```css
html[data-nav="collapsed"] .bs-sidebar__tools .btn { flex: none; width: var(--control-sm); padding: 0; justify-content: center; align-self: center; }
```

`align-self: center` un-stretches the flex-column item; 36px box centered in the 52px column lands at x=16 — matching the clock trigger (x=15.5 measured, subpixel). Expected post-fix: Add node 36×36 at x=16, glyph cx 34 — identical box to the range trigger.

**Mockup mirror** — `mockups/irori-v14.css:35`:

```css
html[data-nav="collapsed"] .bs-sidebar__tools .bs-btn { width: var(--control-sm, 36px); padding: 0; justify-content: center; align-self: center; }
```

(mockup uses fallback-bearing `var()` per its standalone convention.)

**Test pin** — extend the verbatim-rule pins in `apps/web/test/ds-markup.test.ts` (~:110-122, the IR-238 block) with the new `.btn` rule; the old `justify-content:center; padding:0` rule text disappears, so its pin (if any) must be replaced, not duplicated.

**Rejected alternatives**

- *Render an `.iconbtn` in collapsed mode* (class swap or JS): duplicates the secondary idiom and reaches for JS where one CSS rule suffices; `.btn--secondary`'s inset border already matches `.iconbtn` visually.
- *Keep the stretched box, glyph centered* (status quo): owner explicitly flags the size mismatch — rejected.
- *34px square* ("one 34px axis" phrasing from IR-238): the 34 is the center **line**, not the control size; the bordered square idiom is 36 (`--control-sm`, clock measured 36×36). Consistency with the paired trigger wins.

**Blast radius**: the rule lives inside `@media (min-width: 901px)` + `html[data-nav="collapsed"]` — the ≤900 hamburger menu (`App.vue:321-327`, its own `.bs-sidebar__tools` with a label-only Add node) and the expanded sidebar are untouched. CSS-only: no migration, no API, no a11y change (button keeps title + becomes visually icon-only, same as today).

## Delivery plan (single ticket — no new epic)

This is a one-rule fix: a **single Task under the existing round-10-12 feedback epic IR-237** (same shape as IR-238 S-A, which is a Task under IR-237). No new epic warranted.

**Ticket** — filed as **IR-249** (Task 10024, parent `IR-237`, priority Medium, no labels, sprint 1004 per gate choice):

> **Summary:** Collapsed rail: Add node button keeps menu-tier width — cap to the 36px control square (round-13 feedback)
>
> **Context:** Owner feedback 2026-11-15 on the deployed hub: in the collapsed rail the + (Add node) button is oversized vs the other rail controls and reads pushed left. Measured: box 51×36 (stretched to the tools column) vs the 36×36 range trigger; glyph already on the axis. Inherited from the approved mockup (`irori-v14.css:35` has the same missing width cap).
>
> **Change:** Replace the collapsed `.btn` rule with a capped centered square (`width: var(--control-sm); align-self: center; …`) inside the ≥901 media block; mirror in `mockups/irori-v14.css`; update the `ds-markup.test.ts` verbatim pin.
>
> **Acceptance criteria:**
> 1. Collapsed rail ≥901: Add node renders 36×36 centered on the axis — measured box x=16, w=36, h=36, matching the range trigger's box.
> 2. ≤900 hamburger menu and expanded sidebar unchanged (Add node keeps its label and full-width menu styling).
> 3. Mockup re-measured: + box 36×36 centered (matches the app fix).
> 4. `apps/web/test/ds-markup.test.ts` pins the new rule; workspace green.
> 5. Deployed verification: dev tag → re-measure on the hub with the research recipe (this doc).

Ordering: no dependencies (pure CSS), so it can land in any round-13 batch.

## Risks & open questions

- **Sprint 1004 ends today 20:52Z.** Options: file to **backlog** (round-8 gate pattern: "sprint placement at next planning") or into 1004 so it rides the rollover. → Ask at the gate.
- **Type**: Task (matches IR-238) vs Bug. Defaulting to Task for consistency; a Bug label is equally defensible. → Ask at the gate.
- No technical risk: CSS-only inside a media-scoped collapsed block; verified blast radius above.

## Jira overlap findings

- **IR-238** "S-A: Collapsed-rail centering …" — **Done**. Its diff (`3a1372a`, reviewed) touched brand/chevron/popover-trigger/foot only; the Add node `.btn` rule was left at `justify-content:center; padding:0` with no width cap. This is a follow-up, not a duplicate.
- **IR-224** (epic, To Do) — text search hits ("collapsed", "Add node") are its round-8 shell scope; it does not carry + button geometry, and the round-8 S4 story shipped.
- **IR-226** (To Do) — ADR-0019 themes; obsolete per the round-8 plan (owner to close), unrelated.
- No open ticket covers the + button → new single ticket justified.
