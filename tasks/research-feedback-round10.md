# Research: UI feedback round 10 — sidebar icon alignment, hub-disk alarm clarity + action, cleanup live refresh

Owner feedback, 2026-11-14, on the deployed hub (dev-0.7.0-20 lineage). Three items, verbatim:

**Created 2026-11-14 (owner-approved in conversation): epic [IR-237](https://blastersystems.atlassian.net/browse/IR-237) + tasks IR-238 (S-A rail centering), IR-239 (S-B hub banner honesty), IR-240 (S-C cleanup live refresh), IR-241 (S-D minimal per-rule webhook UI — gate decision), IR-242 (S-E NAS-origin labeling — gate decision), all assigned to sprint 1004 "IR Sprint 4". IR-200 closed Done with an evidence comment and Relates-linked to IR-237 and IR-224. This doc is posted as the IR-237 epic comment (id 26027).**

1. "collapsed sidebar lack if icon alignement" — icons misaligned in the 68px collapsed rail (round-8 S4, IR-228).
2. "have an alarm for hub disk pressure, I assume is from the NAS but I have no way to take action" — the Hub disk pressure banner is misattributed (it is NOT the NAS) and offers no action path.
3. "the node disk pressure from DGX-3, when I make a change on the clean up, I need to refresh the page to update" — cleanup changes don't refresh the UI.

## Jira target

| Field | Value | How resolved |
|---|---|---|
| Project key | `IR` (id 10004, "Irori") | Repo convention `IRI-<n>` in AGENTS.md (project-context file) + mwa-jira-rest §Site 3 |
| Site host | `https://blastersystems.atlassian.net` | mwa-jira-rest §Site 3 (credentials `JIRA_EMAIL_BLASTERSYSTEMS`/`JIRA_API_TOKEN_BLASTERSYSTEMS`) |
| Board id | **5** — "IR board", simple | Live REST probe 2026-11-14 (`GET /rest/agile/1.0/board` filtered on `location.projectKey === "IR"`) |
| Issuetype ids | Subtask `10020`, Epic `10021`, Story `10022`, Bug `10023`, Task `10024` | `createmeta?projectKeys=IR&expand=projects.issuetypes` (2026-11-14) |
| Active sprint | **1004 — "IR Sprint 4"**, ends 2026-11-15T20:52Z | `GET /rest/agile/1.0/board/5/sprint?state=active` (2026-11-14) — note: expires tomorrow; execution likely lands in the next sprint (owner call) |
| Assignee | `<redacted-jira-account-id>` (Bruno Pires) | `GET /rest/api/3/myself` (2026-11-14) |
| Comment rules | Plain text only — ALL inline marks rejected in comments (bisected IR-29) | mwa-jira-rest §Site 3 |

## Summary

All three items are follow-on UX debt from the IR-200 (disk-pressure visibility) and IR-224 (DS v1.4 shell) deliveries:

- **Item 1** is a CSS defect inherited from the round-8 S4 collapsed rail (and its mockup): three centering rules are inert because their containers aren't flex/inline contexts.
- **Item 2** is grounded misattribution + a deliberate-but-unhelpful read-only row: the "Hub disk pressure" alarm is the **hub VM/container filesystem** (`hub_disk_pct`), not the NAS; **zero alert webhooks are configured** (live probe: `hasWebhook: false` on every rule); the hub row is title+summary+prose hint only (no CTA, no link, no copyable command), while node rows get a real cleanup CTA. NAS fullness would surface as **per-node** "Disk usage warn" rows (CIFS mounts are included in the `disk_pct` max), a second attribution trap.
- **Item 3** is a stale-data defect: after a hygiene-clean job on DGX-3, the drawer/banner numbers only update on full page reload.

## Current state (evidence)

### Live hub state (probed 2026-11-14)

- `GET /api/v1/health/findings` (hub 10.20.30.9:3947): open findings = 3× `clock_cap_drift` warn (one per spark node), `hub_disk_pct` warn **"Hub disk warn: 80 ≥ 80"** (fleet, `nodeId: ""`, since 2026-11-14T14:38Z), `disk_pct` warn **"Disk usage warn: 88.1 ≥ 80"** on **DGX-3** (since 2026-11-11).
- DGX-3 snapshot storage attribution: `/` ext4 **86.8%** (937 GB), `/mnt/nas` cifs **54.9%** (16.8 TB), `/boot/efi` 1.4%. → The DGX-3 finding is the **local root disk**, so the existing cleanup CTA is aimed at the right disk; item 3 is purely refresh staleness. The NAS at 54.9% is NOT what triggered anything — confirming the owner's NAS assumption is wrong for both current findings.
- `GET /api/v1/health/rules`: every rule has `hasWebhook: false` — no push alarm channel is configured anywhere; the banner is the only alarm.

### Item 2 — hub disk pressure: what exists, what misleads

| Layer | Hub | Node | NAS |
|---|---|---|---|
| Metric id | `hub_disk_pct` (`packages/core/src/health.ts:29-30`) | `disk_pct` (`packages/core/src/health.ts:10`) | none dedicated |
| Seed rule | "Hub disk warn" gte 80 warn, cooldown 3600, fleet (`packages/core/src/health.ts:133`) | "Disk usage warn" gte 80 warn, cooldown 3600, per node (`packages/core/src/health.ts:115`) | — |
| Measures | `statfs(config.hubDiskPath)`; `HUB_DISK_PATH` default `/` = hub container root (`apps/server/src/index.ts:307-310`, `apps/server/src/config.ts:44,66`) → tracks the hub VM disk | max used-% over **all** `snapshot.storage` mounts (`apps/server/src/health.ts:50-54`); agent statfs's every real mount incl. **CIFS** (`apps/agent/src/collector.ts:73-85,679-738` — `cifs` not in `EXCLUDED_FS_TYPES`) | No named rule; a full NAS share inflates every mounting node's `disk_pct` max → "Node disk pressure · <node>" rows. Deliberate mismatch: node *card* DISK row ignores NAS mounts per owner rule 2026-10-25/IR-98 (`apps/web/src/card-data.ts:122-128`) while the *rule* includes them |
| UI row | "Hub disk pressure" + server summary + plain-text hint "check the hub VM filesystem — docker build cache is the usual culprit (docker system df on the deploy host)" — **read-only**: no CTA, no link, no dismiss (`apps/web/src/components/HealthBanner.vue:30,38,82-93`) | "Node disk pressure · <linked node>" + **"Clean up disk — est. +N GB"** CTA opening CleanupDrawer (`HealthBanner.vue:104-113`) | Display-only NAS store card, warn-colored (`apps/web/src/overview.ts:288-310`, `OverviewView.vue:717-719`) |
| Action path | **None in code.** Prose-only runbook: `docs/DEPLOYMENT.md:189-198` (docker system df / builder prune / image prune -a on the deploy host). CleanupDrawer dispatches to fleet-node agents only; there is no job channel to the hub VM (`docs/SPEC.md:165-171` codifies the asymmetry) | CleanupDrawer (4 entry points: HealthBanner row, NodeDetail chip, ModelsView placement row, ServeView placement row) | none |
| Alarm channel | Per-rule `webhookUrl` (encrypted secret + `alert_channels`, `apps/server/src/health.ts:309-329`; POST body `{rule, metric, severity, state, nodeId, summary, observed, at}`) — **API-only** (`PUT /api/v1/health/rules/:id`), no web UI, and **none configured** (live probe) | same | same |

Owner-facing reading: "have an alarm for hub disk pressure" = the banner they saw; the complaint decomposes into (a) it doesn't say *which* disk (no mount/device/HUB_DISK_PATH surfaced — summary is just "Hub disk warn: 80 ≥ 80"), (b) it offers no way to act (hint is prose they must transcribe to a shell), and (c) the natural wrong guess ("NAS") isn't refuted anywhere in the UI.

### Item 1 — collapsed sidebar icon alignment (68px rail: three inert centering rules)

The collapsed rail's **nav icons are correctly centered** (`.bs-nav-item` is a real flex container; `irori.css:207`). The misalignment comes from the three icon controls **around** the nav, whose centering rules are CSS no-ops — measured icon centers in the 68px rail: **glyph x=15, chevron x=44, nav icons x=34, clock x=26, Add-node x=34** (a 29px spread where the design intends one 34px column):

- `irori.css:203` `html[data-nav="collapsed"] .bs-sidebar__brand { justify-content:center; padding:0 }` — the brand is a **plain block** (base `:124` has no `display`), so `justify-content` is inert; its inline-flex children (30px glyph + 28px chevron) pack from the left → glyph center 15 (−19px).
- `irori.css:205` `.bs-sidebar__collapse { position:static; margin:0 auto }` — auto margins on an **inline-level** box compute to 0 → inert → chevron center 44 (+10px).
- `irori.css:214` `.rangeseg-pop { display:block }` — its inline-flex 36px clock `iconbtn` (`:235-238`) left-aligns at the content edge (8px padding, `:211`) → clock center 26 (−8px). Nothing centers it (no `text-align` on the path).
- Already correct: nav icons (`:207`) and the Add-node `.btn` (flex child of the column-flex tools block stretches to 52px; `justify-content:center`, `:215`) — both center at 34.
- **Inherited from the approved round-8 mockup**: `mockups/irori-v14.css:21-39` carries the identical no-op rules (same mockup-carries-the-defect class as round-9's −24.4px endorse/chevron overlap). The port also dropped the mockup's `html[data-nav="collapsed"] .bs-sidebar__status { align-items:center }` (`mockups/irori-v14.css:39`), so foot text hugs left.
- Propagation: the rail popover is JS-positioned from the trigger's live rect (`App.vue:176-177`, `left = btn.right + 8`), so the clock trigger's −8px shifts the popover's left edge to 52px instead of 60px — fixing the trigger corrects the popover with no JS change (rect recomputed per open).
- Round-9's research doc claims the collapsed chevron was "browser-verified" centered (`tasks/research-ds-v14-ui-feedback-round-9.md:40`) — contradicted by the CSS physics above [INFERENCE: that verification passed on the expanded tier or a different element].
- `--sidebar-width-collapsed` is **never defined**; 68px exists only as the `var(…, 68px)` fallback (`irori.css:201-202`).

### Item 3 — cleanup changes need a page refresh (three independent stale layers)

The drawer's post-clean flow already works *inside* the panel: `runClean` (`CleanupDrawer.vue:178-197`) runs the `hygiene-clean` job to completion (2 s REST polling, `:49-58`), renders the final `outcomes` line, then `await refresh()` (`:196`). What's stale is everything **around** those outcomes — three layers:

1. **Drawer rows/chips re-read the pre-clean audit.** `refresh()` re-fetches `GET /api/v1/nodes/:id/cleanup` (`app.ts:997-1007` → `cleanup-service.ts:82-88`), which returns `latestAudit` = the newest `cleanup_runs` row of `kind='audit'`. **A `hygiene-clean` never writes an audit row and nothing re-audits after a clean** (agent invalidates its ~5-min audit cache, `apps/agent/src/main.ts:314`, but the DB row is untouched; the only automatic dispatch is the weekly safe-pass, `apps/server/src/index.ts:562-589`). So category rows, the "X reclaimable" chip and the "Disk X%" chip keep pre-clean values until someone clicks **Re-audit** (`runAudit`, `CleanupDrawer.vue:159-167`). A page refresh does not fix this layer either.
2. **The banner's "Clean up disk — est. +N GB" is frozen per page-load.** `HealthBanner.vue:49-67` fills its `reclaim` map once per node (`if (reclaim.value.has(row.nodeId)) continue;`, `:54`) and never invalidates it — even after a fresh audit row lands. Same once-per-node guard in `ServeView.vue:687-700` (`hygieneOffers`). Only a full reload re-mounts the component.
3. **The banner row's pct is frozen at appear-time.** Findings summaries are built from `observedValue` written once at appear and never updated while the finding stays open (`apps/server/src/health.ts` `evaluate()`/`findings()`); the web refetches findings only on `health` SSE **transitions** + boot (`apps/web/src/live.ts` `case "health"`). A clean that frees enough space clears the rule within ~2 s (snapshot cadence default 2000 ms, `apps/server/src/config.ts:43,65`) → `health: clear` frame → row disappears; a clean that doesn't cross the threshold leaves the row at its stale pct. Extra gap: `es.onopen` reconciles **nodes only** (`live.ts`), so a `health` frame lost during an EventSource disconnect is never reconciled until reload.

DGX-3 reconstruction [INFERENCE]: banner CTA → drawer → audit → typed confirm → clean succeeds → outcomes table updates, but rows/chips/banner est. keep pre-clean numbers → the owner reloads the page (which re-fetches findings + the reclaim map) and sees the change. The node card's DISK bar is the one surface that *does* live-update (live SSE snapshot map, `card-data.ts:122-149`) — making the neighboring staleness more visible. Untested behavior either way: `cleanup-drawer-ir84.test.ts` pins only poller/confirm mechanics.

## Gap analysis

| # | Gap | Consequence |
|---|---|---|
| G1 | Hub banner row surfaces no mount/device/`HUB_DISK_PATH` and its hint is non-copyable prose | Owner misattributes the pressure to the NAS; no way to act without reading docs/DEPLOYMENT.md separately |
| G2 | No hub-host action affordance of any kind (by design today, SPEC.md:165-171) | "no way to take action" — exactly the owner's words |
| G3 | Zero webhooks configured; webhook config is API-only (no UI, no docs-facing recipe on the hub itself) | The only alarm is the banner an operator must be looking at |
| G4 | NAS-origin disk pressure renders as per-node rows with a node-cleanup CTA that cannot reclaim NAS space | Future misattribution trap (inverse of today's) |
| G5 | Collapsed rail: three inert centering rules leave glyph (−19px), chevron (+10px), clock (−8px) off the 34px axis; inherited from the round-8 mockup | Visual defect on every page; the rail popover anchor inherits the −8px |
| G6 | Cleanup apply leaves three stale layers (pre-clean audit row; per-page-load banner est.; appear-time-frozen finding pct + no reconnect reconciliation) | Owner believes the action "didn't work" and reloads the page |

## Proposed design

**Decision: three focused stories in a "UI feedback round 10" epic — a CSS fix (S1), an honesty+action pass on the hub banner row (S2), and a post-action refresh (S3) — extending IR-200's delivered surface rather than reopening it.** Rejected: a hub-host cleanup agent (new trust boundary + ADR; manual SSH stays, but the command becomes copyable); a new notification system (webhooks already exist — none are configured, and wiring one is config, not code); touching the NAS rule/card mismatch beyond labeling (separate round unless the owner opts in at the gate).

- **S2 (item 2) — hub banner: name the disk, make the remedy copyable.**
  - Server: `findings()` summary assembly (`apps/server/src/health.ts:403-423`) for `hub_disk_pct` includes the configured path, e.g. "Hub disk warn: 80 ≥ 80 (hub VM filesystem, HUB_DISK_PATH=/)" — the server already holds `config.hubDiskPath`; no new endpoint, no schema change.
  - Web: hub row hint (`HealthBanner.vue:30,82-93`) becomes an actionable block: one-click copy of the runbook commands (`docker system df`, `docker builder prune`) via the existing `apps/web/src/clipboard.ts` `copyToClipboard` (which already handles insecure http:// LAN origins), plus a link to the "Signal runbook" section of `docs/DEPLOYMENT.md:189-198`. The phrase "hub VM filesystem" in the row is what refutes the NAS assumption in place.
  - Alarm option (owner call, additive): a small settings affordance or documented recipe for per-rule webhooks (mechanism exists: `PUT /api/v1/health/rules/:id` with `webhookUrl` → encrypted secret + `alert_channels`, `apps/server/src/health.ts:309-329`; payload `{rule, metric, severity, state, nodeId, summary, observed, at}`; appear-only notify + always-clear, cooldown-bounded). Today `hasWebhook: false` on every rule.
  - NAS-labeling option (owner call): `metricValue` (`apps/server/src/health.ts:50-54`) records *which* mount produced the max, so a CIFS-sourced finding can render "NAS share mounted on <node>" instead of a node-cleanup CTA that cannot reclaim NAS space (G4).
- **S1 (item 1) — collapsed-rail centering: make the three inert rules real flex.** All CSS, no JS, no markup; mirrored into the mockup (mockup-first rule — the mockup carries the defect):
  ```css
  /* irori.css:203 — brand becomes a real flex container; stack glyph + chevron
     on the 34px axis (30+28px can't share a 68px row) — costs ~+36px height */
  html[data-nav="collapsed"] .bs-sidebar__brand { display:flex; flex-direction:column; align-items:center; gap:8px; padding:0; }
  /* irori.css:205 — margin:0 auto is redundant once the parent centers */
  html[data-nav="collapsed"] .bs-sidebar__collapse { position:static; margin:0; transform:rotate(180deg); }
  /* irori.css:214 — flex blockifies/centers the 36px iconbtn (also fixes the popover anchor) */
  html[data-nav="collapsed"] .bs-sidebar__tools .rangeseg-pop { display:flex; justify-content:center; }
  /* mockup parity — dropped in the port (mockups/irori-v14.css:39) */
  html[data-nav="collapsed"] .bs-sidebar__status { align-items:center; }
  ```
  Nav items (`:207`) and Add-node (`:215`) stay as-is. Optionally promote the fallback to a real `--sidebar-width-collapsed: 68px` token (`:201-202`).
- **S3 (item 3) — post-cleanup refresh: close all three stale layers with the least-surface set.**
  - **Drawer auto-re-audit** (layer 1): after a settled `hygiene-clean`, automatically follow with a `hygiene-audit` (reuse `runAudit`'s tail, `CleanupDrawer.vue:159-167`) before/instead of the bare `refresh()` at `:196`. The agent's audit cache is already invalidated by the clean (`apps/agent/src/main.ts:314`), so the fresh audit is guaranteed accurate; rows/chips update in place. No server machinery.
  - **Banner est. refetch** (layer 2): drop the once-per-node `reclaim.value.has()` guard in `HealthBanner.vue:54` (refetch per `nodeDiskFindings` change — transitions are rare, cost is one GET per row) and/or refetch reclaim on drawer `@close`; same for `ServeView.vue:687-700`.
  - **Honest pct while a finding stays open** (layer 3, server): in `evaluate()`, update `observedValue` on an already-open finding at each evaluation so refetches show the current pct — small server change, no schema change (summary is rebuilt by `findings()` from the stored value).
  - **SSE reconnect reconciliation** (layer 3, one line): add findings refresh to `es.onopen` in `apps/web/src/live.ts` (mirrors the existing `refreshNodes`).
  - Rejected: pushing hygiene results over SSE (new event class + fan-out for a rare transition); marking the audit row stale in the DB (schema/semantic churn for what is a re-audit away from correct).

## Phased delivery plan (epic + stories)

**Epic — "UI feedback round 10: rail alignment, hub-disk honesty + action, cleanup live refresh"** (Epic `10021`). Goal: the three owner-reported friction points from using the deployed hub are gone — the collapsed rail reads as one aligned column, the hub-disk alarm names its disk and offers a copyable remedy, and cleanup results appear without a reload.

Order: S-A → S-B → S-C are independent (S-A pure CSS; S-B server summary + web banner; S-C web data flow + one small server change) — any order works; S-A first as it is a zero-risk CSS-only fix.

- **S-A (Task) — Collapsed-rail centering.** The four-rule CSS fix (see S1) mirrored into `mockups/irori-v14.css:23,25,34,39`. AC: at ≥901px collapsed, all five icon centers measure 34px from the rail's left edge (glyph, chevron, nav icons, clock, Add-node); popover left edge returns to trigger.right + 8 (60px); expanded mode and ≤900px hamburger tier unchanged; string-pin added per `apps/web/test/ds-markup.test.ts` convention; no console errors; light+dark verified.
- **S-B (Task) — Hub-disk banner: name the disk, make the remedy copyable.** Server summary gains the gauge path; hint block becomes copyable runbook commands + runbook link (see S2 above). AC: with a live `hub_disk_pct` finding, the banner row names "hub VM filesystem" with the configured `HUB_DISK_PATH`, and the copy button puts `docker system df` / `docker builder prune` on the clipboard (works over http:// LAN origin); node rows and DB row unchanged; findings wire schema additive-only (summary text change).
- **S-C (Task) — Cleanup apply refreshes the UI without a reload.** The four-part least-surface set (see S3): drawer auto-re-audit after a settled clean; banner est. refetch on findings change/drawer close (HealthBanner + ServeView); server updates `observedValue` on open findings per evaluation; `es.onopen` reconciles findings. AC: on DGX-3 — run a clean → drawer rows/chips show post-clean numbers without manual Re-audit; banner est. updates on the next findings transition without reload; a finding that stays open shows its current pct, not appear-time; a lost SSE reconnect reconciles findings. Existing `cleanup-drawer-ir84.test.ts` still green; new pins for the auto-re-audit + observedValue update.
- **S-D (Task, approved at gate) — Minimal per-rule webhook alarm UI.** Health-rules webhook affordance on the existing hub settings surface: per-rule set/clear of `webhookUrl` + `hasWebhook` state, calling the existing `PUT /api/v1/health/rules/:id`; secret stays encrypted at rest. IR-241.
- **S-E (Task, approved at gate) — NAS-origin labeling.** `metricValue` records which mount produced the max, carried in the finding summary text (no DB migration) so a CIFS-sourced finding renders "NAS share /mnt/nas" and the banner drops the cleanup CTA for it (local cleanup cannot reclaim NAS space). IR-242.

Effort estimates: owner's call (none fabricated).

## Risks & open questions

1. Sprint 1004 ends 2026-11-15 — **gate decision: tasks go on the current sprint 1004** and roll over with it if unfinished.
2. **IR-200 was effectively delivered** (all 5 children IR-201..205 Done) — **gate decision: closed Done 2026-11-14** with an evidence comment; IR-237 Relates-links to it and to IR-224.
3. **IR-224** still has IR-226 (S2 ADR-0019) + IR-227 (S3 themes) To Do — recorded as "proposed obsolete" during round-8 closeout, left for the owner's close call; the sidebar item (round-8 S4 lineage) would `Relates` to IR-224.
4. NAS attribution (G4) — **gate decision: included as S-E (IR-242)**, summary-text-only (no DB migration).
5. `HUB_DISK_PATH` blind spots remain accepted (container `/` sees the hub VM fs, not the pg host — IR-200's recorded open question).
6. Hub-disk remediation stays manual (SSH to the deploy host) unless the owner opts into a hub-host agent — a new trust boundary that would need its own ADR; the minimal action path is a copyable command block / runbook deep-link, not remote exec.

## Jira overlap findings (searched 2026-11-14, REST `search/jql` with nextPageToken)

- Open epics: **IR-200** "Disk-pressure and degraded-database visibility with operator CTAs" (To Do — but all children IR-201..205 Done; stale-open) and **IR-224** "DS v1.4 adoption + shell controls round (UI feedback round 8)" (To Do — S1/S4–S8 Done; IR-226/IR-227 To Do, proposed obsolete).
- Keyword sweeps (`disk`, `cleanup`, `sidebar`, `alert`, `refresh`, `icon` over open issues) surface only those two epics. **No open ticket covers sidebar icon alignment or cleanup-drawer refresh staleness.** IR-200 covers the disk-pressure surface items 2 extends.
- Prior art (Done): IR-160 (health rules engine + webhooks + Prometheus, the IR-200 base), IR-98/IR-104 lineage for card vs rule NAS handling, IR-228 (S4 collapsed rail).
