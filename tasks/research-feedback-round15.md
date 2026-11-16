# Research — Feedback round 15: transfers dock history clear + wide-screen layout

Date: 2026-11-16 · Repo: `main` (prod hub `dev-0.7.0-24`) · Method: two repo scouts (file:line evidence) + live Jira probe (blastersystems, 2026-11-16) + prior research `tasks/research-dgx3-modelctl-clockcap-layout.md`.

## Jira target

- Project key **`IR`** · site **https://blastersystems.atlassian.net** · scrum board **5** ("IR board", simple). Issuetype ids re-verified live via createmeta 2026-11-16: Epic `10021`, Story `10022`, Bug `10023`, Task `10024`, Subtask `10020`.
- Myself: `557058:6ac36ac5-ea1b-48f6-8c57-273b457b2f9c` (Bruno Pires).
- **Sprint: none valid.** `board/5/sprint?state=active` still returns 1004 "IR Sprint 4" but its end is 2026-11-15T20:52Z — a past-end sprint still lists as active yet **rejects adds**; `state=future` → `[]`. New tickets go to **backlog**, pull at next planning (same call as IR-259/260/261 delivered 2026-11-16).
- Resolution path: repo config — `AGENTS.md` IRI-`<n>` convention + managed skill `irori-jira-ticket-filing` ("Project key `IR`; scrum `board_id` = 5") — verified live 2026-11-16. The user did not name a project in this conversation.
- Comments/descriptions: plain text, **no inline marks** (verified on IR-29).

## Summary

Two asks from 2026-11-16 screenshots (Overview + Transfers dock on `dev-0.7.0-24`):

1. **"Clean the recent downloads"** — the dock's Earlier list. It is the hub's *settled jobs* feed (all kinds: downloads, hygiene/staging audits, …), persisted in Postgres, with **no clear affordance, no DELETE route, no retention anywhere** — settled rows accumulate forever. → **one new Task** (server route + store fn + dock button).
2. **"Center the content / use the screen real estate better"** — **already filed: IR-261** (Task, To Do, created 2026-11-16T11:46Z): mockup-first `margin-inline: auto` on `.content`, owner decision recorded. The "use the space better" variant (raise `--content-max` / more columns) is explicitly **out of IR-261's scope** → owner call at the gate.

No epic: one new ticket + one reuse.

## Current state (evidence)

### 1. Transfers dock history

- **Component**: `apps/web/src/components/TransfersDock.vue` — header + LIVE chip (`:100-108`), `no active transfers` (`:139`), Earlier section (`:140-156`), footer `updates live · survives navigation & reload` (`:154`). Mounted v-if from `App.vue:353` (fixed 400px right overlay, `TransfersDock.vue:160-176`).
- **Data**: reads the SPA-singleton `live.jobs` Map (`apps/web/src/live.ts:447`, Map at `:110,134`); `recent` = settled jobs by `finishedAt`, `.slice(0, 12)` (`TransfersDock.vue:30-34`) — **12 is display-only**. Seed on mount → `live.refreshJobs()` (`live.ts:332-350`) → `fetchRecentJobs(20)` (`apps/web/src/jobs.ts:98-116`) → **`GET /api/v1/jobs?limit=20`** (`apps/server/src/app.ts:1736-1744`). Live: SSE `job` / `job-progress` frames (`live.ts:222-256`; hub emits `index.ts:355,360,446`).
- **Persistence**: hub Postgres `jobs` table (`packages/db/src/schema.ts:184-211`) + per-job `job_output` ring (`:213-221`). Read path `JobsService.listAll()` newest-first (`apps/server/src/jobs-service.ts:416-447`), limit clamped ≤100 (`:417`). Reload-survival comes from Postgres, not localStorage (web stores only sidebar/theme/sort keys).
- **No clear/prune exists**: jobs routes are only create/list/get/cancel (`app.ts:1689,1736,1745,1756`); zero `delete(jobs)` in server/db/agent (grep-verified); the 60 s reaper (`index.ts:637-642`) and `reapOffline` only update status. Settled rows live forever; rows leave only via node-deletion FK cascade (`schema.ts:188-190`). Store caps are display-only (dock 12, web Map 50 `live.ts:342-349`, API ≤100).
- **Closest precedent**: IRI-026 download-queue **auto-clear** — frontend-only, deletes `download_queue` entries via the existing `DELETE /api/v1/downloads/:id` (`apps/web/src/models.ts:333-339`) — a different store than `jobs`.

### 2. Wide-screen layout

- Shell: `.shell` grid `232px | minmax(0,1fr)` (`irori.css:118`); every view renders in the single `<main class="content">` (`App.vue:335-347`).
- The only width rule: `.content { padding: 28px 32px 48px; min-width: 0; max-width: var(--content-max) }` = **1360 px, no `margin-inline: auto`** (`irori.css:249`, var `:71`). Cap binds above ~1592 px (expanded sidebar) / ~1428 px (collapsed rail) → left-hugging column, sticky topbar still full-width.
- DS v1.1 is **vendored, not a package** (ADR-0018): the mockup source is byte-identical (`mockups/irori-v11.css:175`), and `apps/web/test/ds-markup.test.ts:104` pins the rule verbatim. The pre-IR-217 shell centered at 1200 px; IR-217 deliberately removed it (`tasks/IR-217-shell.md:26-28`).
- Overview internals are `1fr`-based and stretch to whatever `.content` gives: hero 2-col (`OverviewView.vue:845-850`), nodes `.cols-3` (`:653`), Power/NAS 2-col (`:662`); breakpoints are media queries (`irori.css:524-598`) + JS tiers small/medium/full (`apps/web/src/tiers.ts:14-40`).
- **Blast radius of centering is global** (all 11 views share `.content`; no page overrides the cap, so none regresses asymmetrically). The Transfers dock is a pure fixed overlay — no interaction.
- **IR-261 already covers this** (To Do): change = add `margin-inline: auto` in the v1.4 mockup mirror, browser-verify light/dark, then apply to `irori.css:249` + update the `ds-markup.test.ts:104` pin. Out of scope per ticket: per-view max-width changes, sidebar geometry, mobile shell.

## Gap analysis

| # | Ask | Gap |
|---|---|---|
| G1 | Clear recent downloads | No UI control, no route, no retention for settled `jobs` rows — the feed can only grow |
| G2 | Center content | **No gap** — IR-261 open (To Do) with owner decision recorded |
| G3 | "Use the real estate better" (raise cap / more columns) | No ticket; explicitly out of IR-261 scope; needs a separate owner decision |

## Proposed design (decisions + rejected alternatives)

### S1 — Transfers dock: Clear history (new ticket)

- **Server**: `DELETE /api/v1/jobs` beside the list route (`app.ts:1736`) → new `JobsService.clearHistory()` (`jobs-service.ts`, interface `:195-240`) deleting rows with `status IN ('succeeded','failed','canceled')`. Queued/running rows are never touched (the partial unique index `schema.ts:208` keeps the active slot). `job_output` cascades (`schema.ts:219`); `download_queue.job_id` / `cleanup_runs.job_id` are `ON DELETE SET NULL` (`:314,505`). Wrap in `audit(...)` like job cancel (`app.ts:1756`).
- **Web**: `clearJobs()` helper in `apps/web/src/jobs.ts` (pattern `fetchRecentJobs:98`); a `Clear history` button in the dock footer (`TransfersDock.vue:154-159`), shown only when settled rows exist; on 204 → `await live.refreshJobs()`.
- **Semantics**: clears **all settled jobs of every kind** (the dock's history *is* the settled-jobs feed — it shows hygiene/staging audits too, not just downloads). Past job output (the 400-line rings) becomes unrecoverable; the audit row records the clear.
- **Rejected**: new SSE `jobs-cleared` frame (core schema + ingest-arm churn; the dock is the only settled-history surface, other tabs refresh on next job frame or reload — cosmetic); auto-retention/TTL (not asked; IR-026's auto-clear belongs to `download_queue`, not `jobs`); per-entry dismiss (heavier UI, not asked).

### S2 — Centering (reuse IR-261, no new ticket)

IR-261 is decision-complete (mockup-first, one property + test pin). If the owner also wants **more space used** (raise `--content-max`, or more node columns at ultra-wide), that is a new decision outside IR-261's recorded scope — grids stretch automatically if the cap rises, but column-count changes (`cols-3` → `cols-4`) are a design call, proposed only on explicit ask.

## Phased delivery plan (approved 2026-11-16)

1. **S1 · Task (Medium), backlog**: "Transfers dock: Clear history" — server route + store fn + audit + dock button.
   Acceptance: `DELETE /api/v1/jobs` removes only settled rows (queued/running untouched, active-slot index intact); `job_output` cascades, `download_queue.job_id`/`cleanup_runs.job_id` go NULL and both consumers still render; route audited; dock footer button clears and the Earlier section empties after `refreshJobs()`; active transfers + Cancel unaffected; server test beside the existing jobs-service tests + web mount test per the IR-175 recipe.
2. **S2**: no ticket — execute existing **IR-261** (mockup-first) whenever scheduled.

Independent; no DB migration (row deletion only). Repo task file at implement time: next `IRI-145` (highest existing IRI-144) — re-check branches + `tasks/` + Jira per convention (IRI-046 collided once).

## Risks & open questions

1. **Sprint**: none valid → backlog; owner pulls at next planning.
2. **SET NULL consumers**: verify cleanup history (and any `download_queue` view) render with `job_id` NULL after a clear.
3. **Irreversibility**: clearing deletes job output rings; acceptable for an ops feed (audited), but confirm at the gate.
4. **"Use space better"**: only centering is ticketed (IR-261); a raised cap / column-count change needs an explicit owner decision.
5. Multi-tab staleness window after clear until next `job` frame — cosmetic, accepted.

## Jira overlap findings

Live JQL on `blastersystems` 2026-11-16: **open epics: none**. `text ~ "transfer"` → 0 open. `clear/clean/prune` → only IR-259 (clock-cap false positive, unrelated). `center/layout/screen/wide` → **IR-261** (exact match for the centering ask) + IR-260 incidental. Prior art: IRI-048 (dock, Done), IRI-026 (queue auto-clear, different store). S1 is new; no duplicate.

## Delivered (2026-11-16)

- **IR-262** created (Task, Medium, backlog — no valid sprint; assigned `bruno@blastersystems.com`): "Transfers dock: clear history for settled jobs". Per-key verified (type Task / To Do / Medium / assignee / sprint null); this doc posted as comment 26099 (34 blocks, end-verified: last heading + tail string present).
- Gate decisions: clear semantics = **all settled jobs** (owner choice); wide screens = **centering only — IR-261 executes as scoped**, no new ticket.
