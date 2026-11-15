# Research — Node page feedback round 14

Feedback: 8 items on the NodeDetail page (deployed hub dev-0.7.0-22, screenshots of DGX-3), 2026-11-15.

**Filed 2026-11-15:** epic **IR-250** + stories IR-251 (S1) … IR-256 (S6), all in sprint 1004; the full doc is epic comment 26080.

## Jira target

- **Project key `IR`** — resolved from repo skill `irori-jira-ticket-filing` ("Project key `IR`; scrum `board_id` = 5") + `AGENTS.md` IRI-<n> convention.
- Site `https://blastersystems.atlassian.net` — verified live 2026-11-15 (`/rest/api/3/myself` → `557058:6ac36ac5-ea1b-48f6-8c57-273b457b2f9c`).
- Board **5** (IR scrum). Issuetype ids (skill, verified 2026-10-19): Epic `10021`, Story `10022`, Bug `10023`, Task `10024`, Subtask `10020`.
- Sprint: active = **1004 "IR Sprint 4", ends 2026-11-15T20:52Z (today)**; **no future sprint exists**. Owner chose **1004** at the gate; all seven issues filed there.
- Epic: IR-237 ("UI feedback rounds 10-12…") is **Done** and has **0 open children** → round 14 gets a **new epic**.
- Overlap: zero open tickets match clock cap / firmware / modelctl install / dgx-release / node page header (JQL, 2026-11-15).

## Summary

One hard bug (silent no-op install — one-line root cause), two data-honesty gaps (stale report outlives agent updates; firmware data collected but unshown), one unexplained health chip, four presentation items. Six stories under a new epic.

## Current state (evidence)

**Header** (`apps/web/src/components/NodeDetail.vue:946-1005`): breadcrumb `Nodes / DGX-3` is plain text (`:947`); chips row: role (non-standalone) `:950`, kind `:951`, status dot `:952`, host `:954`, `Agent 0.7.0` `:955`, `update available` `:956`, health-finding chips `:964-969` (tooltip = `SEVERITY · summary · since`), kernel warn `:970`. CTAs, mixed shapes: Wake `btn--ghost`, Shut down `btn--ghost` (arm-confirm), Edit, Rotate token, Audit (link), updateAgent (when drift, `btn--secondary`), Delete (arm-confirm), Disk hygiene `btn--secondary`, and `<a class="chip detail-back" href="#/">← Overview</a>` **last in the row** `:1005`.

**Inference** `:1041-1042`: heading + `no LLM ports configured` when `llmPanels.length === 0`.

**Models** `:1079-1086`: on non-store nodes a muted filler `store catalog renders on the store node` (`:1080`) + Refresh button; store card renders only on NAS (`:1078`).

**Local cache**: `Install modelctl for {{user}}` button `:1168-1174` → `installModelctl()` `:766-781`; per-cache error banner = `cache.error` (`:1177`).

**Updates card** `:1428-1457`: rows OS / Kernel / DGX OS / NVIDIA driver / Pending reboot / Upgradable packages; firmware rendered **only** as a count chip when >0 (`:1451-1453`, device→version list only in the `title` tooltip); **no report-age label**; `posture` chip from `GET /api/v1/updates` (`apps/server/src/app.ts:1062-1092`: `behind` iff dgxOs ≠ baseline 7.6.0 or driver ≠ 580.178.04, `app.ts:1076-1084`).

**Clock-cap drift rule (IR-189)**: value = consecutive 30 s sweeps with live ceiling ≠ stored cap (`apps/server/src/clock-caps.ts` `driftStreak`); trips at seeded threshold 4 (`apps/server/src/health.ts:411-417`; seed threshold 4: `health-ir69.test.ts:454-455`). Summary is generic `name: v ≥ t` (`health.ts:106-110`). Re-apply fires **only on node hello** (`hub.ts:116-120`, `index.ts:288-304`) — nothing re-applies mid-session. Live on DGX-3: finding `Clock cap drift: 87 ≥ 4` (open since 2026-11-15T11:11:52Z); stored caps GPU 2200 MHz (persistent) + CPU 2000 MHz (persistent) — the driver is not honoring them (likely the TP-3 engine stack resetting app clocks out of band).

**Install no-op (item 6) — root cause**: `NodeDetail.vue:767` `if (opBusy.value || nodeBusyJob !== null) return;` — `nodeBusyJob` is a `computed` (`:705`) used **without `.value`** in script; a ComputedRef is never `null`, so the guard is always true and every click returns before dispatching. Template uses are fine (auto-unwrap), so the button looks enabled and nothing happens. Live audit (`GET /api/v1/audit`): **zero** `modelctl-install` rows for DGX-3 — no job was ever created. Fix: `nodeBusyJob.value !== null`.

**DGX_NAME (item 7)**: parser already fixed agent-side by IR-243 (`apps/agent/src/updates.ts:55-57` prefers `DGX_OS_VERSION`; test `updates-ir81.test.ts:29-35`). What renders today is a **stale pre-fix report**: DGX-3 row `updatedAt=2026-11-14T21:15:27.962Z` (job `c42ddbe3` succeeded 21:15:22Z, pre-roll agent); DGX-3's agent-update `68c66233` succeeded **2026-11-15T08:43:34Z** (new agent). The IR-243 daily sweep (`index.ts:594-623`; stale = ≥ 24 h, `inventory-service.ts:20-22`) re-collected DGX-1/2 at 09:23Z today but **skipped DGX-3** — its 12 h-old row was under the bar. `/api/v1/updates` still returns DGX-3 `dgxOs=DGX_NAME="DGX Spark"`, `posture=behind` (false alarm).

**Firmware (item 8)**: collection exists end-to-end — agent `apps/agent/src/updates.ts:92-114` (`fwupdmgr get-updates --json`, test `:56-75`), core schema `packages/core/src/inventory.ts:109`. The UI shows a count chip only when >0. Live: **all four nodes report `firmwareUpdates: []`** — and the report **cannot distinguish "fwupd absent" from "no updates"** (`updates.ts:93-97` returns `[]` for both). fwupd presence on the fleet unverified this session (ssh probe flaky) — [INFERENCE: Ubuntu 24.04 desktop images ship fwupd; GB10 has LVFS support].

## Gap analysis → findings

| # | User item | Root cause / gap |
|---|---|---|
| F1 | too much noise on top | 6 identity chips (role/kind/status/host/agent/drift) + 2-3 warn chips compete in one row |
| F2 | "Clock cap drift: 59 ≥ 4 means what" | summary is raw metric-vs-threshold; no unit (sweeps), no meaning, no remedy affordance |
| F3 | `← Overview` not well located | back link is a chip at the END of the CTA row; the breadcrumb above is dead text |
| F4 | too many CTAs, mixed shapes | 8 actions with 3 different visual treatments in the header |
| F5 | no inference → show nothing (+ apply page-wide) | permanent empty states render filler text (`no LLM ports configured`, Updates `else` branch, Storage `no data yet`, Versions `else`, Models filler) |
| F6 | can't install modelctl, no error | `nodeBusyJob` missing `.value` → silent return before dispatch (bug) |
| F7 | `DGX_NAME="DGX Spark"` shown | stale pre-fix report + no age label on Updates card + sweep's 24 h bar |
| F8 | add available firmware updates | data collected; UI buries it in a tooltip; fwupd-absent indistinguishable from up-to-date |

## Proposed design (decisions + rejected alternatives)

- **F6 (bug)**: `installModelctl` guard → `nodeBusyJob.value !== null`. Regression: component-mount test (IR-175 recipe, `apps/web/test/`) asserting the click POSTs `modelctl-install`. **This is a live operator-facing defect → Bug, High, can ship alone.**
- **F1+F3+F4 (header, mockup first)**: title row = name + status chip + warning chips only; identity (role · kind · host · agent) demoted to one muted meta line; breadcrumb `Nodes` becomes the back link (remove `← Overview` chip); power actions (Wake, Shut down) stay as buttons, everything else (Edit, Rotate token, Audit, Disk hygiene, Delete, updateAgent when offered) folds into one "Node actions" overflow menu — one shape. Mockup target: `mockups/node-head.html` (browser-verified light/dark before implementation). Rejected: keeping all CTAs visible (the complaint), hiding power actions in the menu (shutdown/wake are the node's primary levers).
- **F5 (empty-state rule)**: a section with no content **and** no action renders nothing. Concretely: hide the whole Inference cell when `llmPanels.length === 0` (Live spans); hide the Updates card when `updateState?.updates` is null (incl. the `unknown` posture chip); drop the `store catalog renders on the store node` filler (keep one Refresh affordance); hide Storage/Versions cards when their data is absent. **Keep**: `waiting for first snapshot` (transient), `no inventory yet` + Read models (actionable), the `modelctl is not installed` banner (has the Install CTA — required by F6), error banners.
- **F2 (drift chip)**: server-side humanized summary for `clock_cap_drift` (per-metric suffix mechanism already exists, `health.ts:106-115`): e.g. `Clock cap drift: stored 2200 MHz cap not in effect ~30 min (59 sweeps)`. Web tooltip states the goal + remedy: the cap saved on the node is not what the driver reports; re-apply from the Clock cap control or clear it if intentional. Optional small CTA on the chip → re-apply stored cap. **Rejected: automatic mid-session re-apply** — the hub can't distinguish an out-of-band operator change (driver reset, `nvidia-smi -rgc`) from drift; a warning is the honest contract (SPEC §10 covers hello-time re-assert only).
- **F7 (stale report honesty)**: add `agent-update` to `INVENTORY_MUTATING_KINDS` (`jobs-service.ts:626-627`) so a successful agent update voids the inventory row — the old report's parsing/counts are the old agent's truth; the existing auto-try (`NodeDetail.vue:516-520`) re-collects on the next visit with the new agent. Plus: report-age label on the Updates card (parity with the Models label, IR-106 semantics). Rejected: lowering the sweep's 24 h bar globally (more fleet load for no operator value).
- **F8 (firmware surfaced)**: render `firmwareUpdates` as rows (`device → version`) in the Updates card; add a fwupd-present flag to the agent's update state so "up to date" vs "fwupd not installed" are distinguishable (agent + core schema + UI); verify fwupd on all four nodes during implementation. Posture stays OS/driver-based (baseline has no firmware component — `app.ts:1076-1084`).

## Phased delivery plan (proposal — pending approval)

New epic (IR, round 14) + 6 stories:

1. **IR-251 — Bug (High): Install modelctl silently no-ops** — the `.value` fix + mount regression test. Shippable immediately, independent of the rest.
2. **IR-252 — Task: Node header redesign (round 14)** — F1+F3+F4, mockup-first (`mockups/node-head.html`), then implement.
3. **IR-253 — Task: Empty-state rule on the node page** — F5 as listed above.
4. **IR-254 — Task: Explain the clock-cap-drift chip** — F2 (summary humanization + tooltip; owner chose explanation-only at the gate — no re-apply CTA).
5. **IR-255 — Task: Agent updates must not leave stale update reports** — F7 (mutating-settle + age label).
6. **IR-256 — Task: Surface available firmware updates** — F8 (list UI + fwupd presence flag + fleet verify).

Order: S1 (bug) → S3/S5/S6 (small, independent) → S4 → S2 (mockup round last, biggest UI delta). No DB migration; S4 touches a summary string (no schema), S5 reuses the mutating-settle mechanism, S6 adds an optional agent field (old agents → absent → UI falls back to the count chip).

## Risks & open questions

1. **Sprint**: 1004 ends today 20:52Z; no future sprint exists — file into backlog and pull at next planning, or into 1004 and move? (owner call)
2. fwupd presence/updates on the fleet unverified (ssh probe flaky this session) — S6 includes the verification step.
3. DGX-3's drift is likely the TP-3 engine stack resetting clocks out of band; the warning is correct behavior — the owner may prefer to clear the stored cap instead of re-applying (S4 keeps both paths available).
4. No ADR needed: no schema/deployment/boundary change (S6's optional field is additive to an existing report).

## Jira overlap findings

No open IR ticket covers any of the eight items (JQL `text ~` / `summary ~` searches, 2026-11-15: clock cap, firmware, modelctl install, dgx-release/DGX_NAME, node page/header → all 0). Prior art: IR-243 (dgx parser + daily sweep, Done), IR-247 (missing-modelctl auto-install + wording, Done), IR-248 (refresh dedupe, Done) — this round builds on them, no duplicates.
