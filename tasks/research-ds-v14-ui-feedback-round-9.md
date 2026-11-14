# Research: DS v1.4 UI feedback round 9 — sidebar header, hero peak honesty, Token stats card

Date: 2026-11-14 · Repo: BlasterSystems/irori · Author: agent (research skill) · Status: **Approved at the gate 2026-11-14 — full pipeline**

**Gate decisions (owner, 2026-11-14):**

- **Full pipeline approved**: create epic + tasks, implement all, one PR, review, merge, deploy.
- **Epic created: IR-233** ("UI feedback round 9 — shell header + overview polish"), tasks **IR-234** (S1), **IR-235** (S2), **IR-236** (S3), all in sprint 1004 "IR Sprint 4", parented and verified.
- **S1 decision changed by the owner**: keep the chevron exactly where it is; shorten the endorse text from "A BlasterSystems product" to **"BLASTERSYSTEMS"** (the rule already uppercases), which frees ~41 px of clear gap — no layout restructure, no mockup reflow. The wrap-to-own-row proposal below is superseded (kept as the rejected alternative).
- **S2 decision**: honest bucket label (web-only).

## Jira target

- Project key `IR` (project id 10004, "Irori") · site `https://blastersystems.atlassian.net`
- Credentials: `JIRA_EMAIL_BLASTERSYSTEMS` / `JIRA_API_TOKEN_BLASTERSYSTEMS` → Bruno Pires, accountId `<redacted-jira-account-id>`
- Board id **5** ("IR board", type simple)
- Issuetype ids (createmeta, verified 2026-11-14): Subtask `10020`, Epic `10021`, Story `10022`, Bug `10023`, Task `10024`
- Active sprint: **id 1004 "IR Sprint 4"** (2026-11-08 → 2026-11-15) — re-verified live; memory's "sprint 990" is stale
- Resolution: repo `tasks/` filenames (`IR-NNN`) + AGENTS.md task convention; all coordinates probed live via REST this session (myself, board list filtered on `location.projectKey === "IR"`, createmeta, active sprint)
- Comment/description rule for this project: plain text, mark-free (IR site rule, verified 2026-10-18)

## Summary

Owner round-9 feedback, three items, all rendered-surface bugs or polish on the deployed hub (DEV-0.7.0-19):

1. **Sidebar header**: the collapse chevron collides with the brand lockup's endorse line ("A BlasterSystems product") — measured **−24.4 px overlap** at 1568 px and −24 px at 1280 px, in the deployed build **and** in the approved round-8 mockup. The 232 px DS sidebar geometrically cannot host the 200 px lockup plus a 28 px button on one row.
2. **Serving hero**: the "peak" sub-label can be **lower than the current value** (owner screenshot: DECODE 106 tok/s over "peak 86"). Root cause: peak is the max over *history buckets* (hour averages at the 24 h range) while the hero value is the *instant* probe — a granularity mismatch, same defect class as the round-8 "honest busiest-bucket" fix (76fe709).
3. **Token stats card**: half-empty row (card measured 528.5 px wide inside a 1069 px 2-col `hero-grid` section) plus two low-value tiles the owner wants gone ("Average per hour", "Busiest hour").

## Current state (evidence)

### Sidebar header

- `apps/web/src/App.vue:231-238` — brand row: `.bs-lockup` (glyph + name + endorse) and `.bs-sidebar__collapse` button with `<BsIcon name="chevron-left" />`.
- `apps/web/src/assets/irori.css:124` — `.bs-sidebar__brand { padding: 0 8px 0 17px; }` (not a flex container).
- `apps/web/src/assets/irori.css:178-180` — `.bs-sidebar__collapse { position: absolute; right: 10px; top: 30px; width/height 28px }`.
- `apps/web/src/assets/irori.css:71` — `--sidebar-width: 232px`. Measured `.bs-sidebar` = 232 px at 1280 **and** 1568 viewports (fixed, no tier growth).
- Measured on the live hub (0.7.0-19) and on `mockups/v14-round8.html` — **identical**: lockup text right edge 217.4 px, collapse left edge 193 px → **overlap 24.4 px**; the endorse line (nowrap, mono 10px, 158 px wide) runs under the chevron.
- `mockups/v11-overview.html` — sidebar also 232 px (DS v1.1 spec value, not a round-8 shrink) but **no collapse control** — the collision was introduced by round-8 S4 (`App.vue:136-159`, collapse feature).
- Collapsed rail is healthy: chevron centers at 68 px rail, rotates 180° (`irori.css:205`); browser-verified.
- ≤900 px: sidebar is replaced by the topbar hamburger (proper 3-line svg, `App.vue:281-283`) — unaffected.

### Hero "peak" sub-label

- `apps/web/src/components/OverviewView.vue:639` — hero Decode: value `p.hero.decodeTps` (instant probe snapshot), sub `peak {{ charts.get(p.key)?.peak }}`.
- `apps/web/src/overview.ts:73-77` — `peakDecode(points)` = max `decodeTps` over history points.
- `apps/web/src/components/OverviewView.vue:211` — points from `fetchLlmHistory(nodeId, range.value)` (the menu range; default 24 h).
- `apps/server/src/history.ts:25-33` — `RANGE_GRANULARITY`: 30m/1h/4h → minute; **24h/7d/30d → hour**. So at 24 h the "peak" is the max *hourly average* — an intra-hour burst (106 tok/s) exceeds every bucket average (86). Contradiction confirmed; live probe reproduced (`Decode — peak 86`).
- `fetchLlmHistory` returns `granularity` (`apps/web/src/api.ts:790-855`) but `refreshCharts` (`OverviewView.vue:189-214`) discards it — the fix is client-side.

### Token stats card

- `apps/web/src/components/OverviewView.vue:754-771` — card wrapped in `<section class="hero-grid section-gap">` (2-col grid, `OverviewView.vue:856-859`) → card occupies column 1 only: measured cardW 528.5 of sectionW 1069 (49.4%).
- `apps/web/src/tokens-data.ts:167-226` — `overviewTokenTiles` returns **8** tiles: Total tokens, Generated, Prompt (input), Cache hit, Output : input, Cost, Average per hour, Busiest {minute|hour|day}; opts `{ windowHours, busiest, granularity }` feed only the last two.
- `apps/web/src/components/OverviewView.vue:244,247-261,284-291,379` — `tokenGranularity` ref, `tokenBuckets` and `busiestBucket` computeds exist **only** to feed those two tiles (cleanup scope).
- Full-width single-card row idiom already exists: Fleet clock caps uses `<section class="card section-gap">` (`OverviewView.vue:780`).

## Gap analysis

| # | Owner ask | Defect | Fix surface |
|---|---|---|---|
| 1 | "look at the menu icon and the icon to collapse" | Collapse button overlaps the lockup endorse line at every desktop width (−24 px); both icons render cramped into one visual blob | `App.vue` brand row + `irori.css`; mockup first |
| 2 | "max decode being lower than the current value??" | "peak" is a bucket-average max presented as if it were the window max — contradicts the instant hero value | `OverviewView.vue` (+ store granularity), web-only |
| 3 | "better manage empty space" + "avg/h and busiest hour not that important" | Card sits in a 2-col grid with an empty second cell; 8 tiles dilute the signal | `OverviewView.vue` + `tokens-data.ts` |

## Proposed design

### S1 — Sidebar header: reserve space for the collapse affordance (mockup first)

**Decision**: keep the 232 px DS sidebar and the top-right collapse position; make the brand row a wrapping flex row so the button drops to its own right-aligned row instead of overlapping the endorse line:

- `.bs-sidebar__brand { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; }` (replaces the padding-only rule; keep the padding)
- `.bs-sidebar__collapse { position: static; }` (drop `absolute; right: 10px; top: 30px`) — when it fits it sits inline right; at 232 px it wraps to its own row (cost ≈ +36 px vertical, taken from the 32 px flex gap before the nav — verify at 900 px-tall windows)
- Collapsed rail: existing `html[data-nav=collapsed]` rules already assume a static, centered button (`irori.css:203-205`) — unchanged behavior, must be re-verified
- Mockup first: apply the same change to `mockups/v14-round8.html` (+ `mockups/irori-v14.css` if the rule lives there), browser-verify expanded/collapsed at 1280 + 1568 + 900-tall, then port. The mockup currently carries the same −24 px overlap, so this is a mockup defect fix, not a deviation.

**Rejected**: widening `--sidebar-width` to 260 px (changes the approved DS v1.1 shell geometry everywhere, touches collapsed math and content max for a one-button problem); truncating the endorse with ellipsis (never truncate the brand); moving the control to the sidebar foot (bigger departure from the approved design).

### S2 — Hero peak: honest bucket label (web-only)

**Decision**: name the bucket in the sub-label, mirroring the round-8 "Busiest hour" vocabulary: `peak {{ word }} {{ n }}` where word ∈ minute/hour/day — e.g. 24 h → "peak hour 86", 30 m → "peak minute 106". `refreshCharts` stores the `granularity` `fetchLlmHistory` already returns; no server change; the value/label contradiction disappears because the label no longer claims to be the window max.

**Rejected**: true window peak via a second minute-granularity fetch (server param + data-availability risk: minute bucket retention for 24 h/7d/30d unverified; heavier for a sub-label); dropping the peak sub (loses a useful comparator); hiding the sub when current > peak (inconsistent flicker).

### S3 — Token stats: full-width row, six tiles

**Decision**:

- Wrapper `<section class="hero-grid section-gap">` → `<section class="card section-gap">` (the Fleet clock caps idiom) — card spans the content row.
- `statgrid--4` → `statgrid--3`; drop "Average per hour" and "Busiest {min/hr/day}" tiles → 6 tiles (Total tokens, Generated, Prompt (input), Cache hit, Output : input, Cost) = 2×3 at full tier; medium (≤1100) and small tiers already re-map `statgrid--3` (irori.css:524,552,594).
- Delete the now-dead plumbing: `opts` param of `overviewTokenTiles`, `tokenGranularity` ref, `tokenBuckets`/`busiestBucket` computeds, their assignments; update `apps/web/src/test/tokens-data.test.ts` (8-tile pins → 6) and any markup pins that reference `statgrid--4` on this card.

**Rejected**: pairing the card with a new sibling (nothing to pair; owner asked to remove content, not add); keeping "Busiest hour" (owner: "not that important on this card" — the granularity-honest busiest insight remains on Analytics).

## Phased delivery plan

Epic: **"UI feedback round 9 — shell header + overview polish"** (IR, Epic 10021, sprint 1004). All web-only; no DB migrations, no server changes, no flags; rollback = previous dev tag. Delivery: one branch, per-ticket commits, one PR (round-8 pattern), reviewer pass, merge, tag `dev-0.7.0-20`, live verify.

| # | Ticket (Task 10024) | Depends on | Key acceptance criteria |
|---|---|---|---|
| S1 | Sidebar header: collapse affordance no longer overlaps the brand lockup | — | Mockup updated first + browser-verified (expanded 1280/1568, collapsed rail, 900-tall window, ≤900 unchanged); deployed header shows ≥8 px clear gap between endorse text and chevron hit-area at 1280–1920; markup test pins the non-absolute button; no console errors |
| S2 | Serving hero: peak sub-label names its bucket granularity | — | At 24 h the sub reads "peak hour N"; at 30m/1h/4h "peak minute N"; week/month "peak day N"; label derived from the response `granularity`, never hard-coded; unit test pins the label per granularity; no server diff |
| S3 | Token stats: full-width row, drop Average-per-hour and Busiest tiles | — | Card is a full-width `card section-gap` row; `statgrid--3`; exactly 6 tiles incl. the fleet-null coverage state; `statgrid--4`, opts plumbing and busiest/average code paths deleted; `tokens-data.test.ts` updated; overflow sweep clean at 320–1920 |

Order S1 → S2 → S3 (S2/S3 share `OverviewView.vue` — one writer, sequential).

## Risks & open questions

1. **S1 vertical cost**: the wrapped button row pushes the nav down ~36 px; verify 900 px-tall windows and that the ≤900 tier never sees the button. Open question: owner OK with the button on its own row vs. e.g. bottom-of-sidebar placement?
2. **S2 semantics**: owner may prefer the *true* window peak (server minute buckets) over an honest label — default is the label (tiny, honest); the alternative is a follow-up server ticket if wanted.
3. **S3 information loss**: the busiest-bucket insight disappears from Overview (it stays on Analytics). Owner explicitly ranked it unimportant — recorded as their call.
4. Round-8 epic **IR-224 is still open**; this round is independent of it (no shared files except `OverviewView.vue`, which round-8 already merged). IR-226/227 closure remains the owner's pending call — untouched here.

## Jira overlap findings

- Open epics: **IR-224** (DS v1.4 round 8 — prior art, its description text-matches "token stats"/"hero"/"sidebar"), **IR-200** (disk pressure — unrelated).
- JQL `text ~` searches for peak / token stats / sidebar / collapse / menu icon / hero (statusCategory != Done): **no open ticket covers any of the three items**; IR-226 (S2 ADR task) matches "sidebar"/"collapse" only via its ADR text.
- Conclusion: new epic + 3 children, no duplicates; link the epic to IR-224 with a `Relates` link as prior round.
