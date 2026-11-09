# Research: Disk-pressure and degraded-database notifications with operator CTAs

## Jira target

**Created 2026-11-09 (owner-approved in conversation): epic [IR-200](https://blastersystems.atlassian.net/browse/IR-200) "Disk-pressure and degraded-database visibility with operator CTAs" + children IR-201…IR-205 (Tasks, sprint 998 "IR Sprint 3", assignee Bruno Pires), Relates→IR-160; the research doc is posted as the epic comment.**

| Field | Value | How resolved |
|---|---|---|
| Project key | `IR` (id 10004, "Irori") | Repo artifacts: ADR-0016 ("Implemented in IR-188"), SPEC.md (IR-98/IR-104/IR-133), task convention `IRI-NNN` in AGENTS.md. No repo skill hardcodes a key — verified fresh via REST on 2026-11-09. |
| Site host | `https://blastersystems.atlassian.net` | `mwa-jira-rest` skill §Site 3 (same pair as Irori/Alevo) |
| Credentials | `JIRA_EMAIL_BLASTERSYSTEMS` / `JIRA_API_TOKEN_BLASTERSYSTEMS` | skill §Site 3 (verified 2026-10-18) |
| Board id | **5** — "IR board", simple/team-managed | `GET /rest/agile/1.0/board?maxResults=50` filtered on `location.projectKey === "IR"` (2026-11-09) |
| Issuetype ids | Subtask `10020`, Epic `10021`, Story `10022`, Bug `10023`, Task `10024` | `createmeta?projectKeys=IR&expand=projects.issuetypes` (2026-11-09) |
| Active sprint | **998 — "IR Sprint 3"** | `GET /rest/agile/1.0/board/5/sprint?state=active` (2026-11-09) |
| Assignee | `557058:6ac36ac5-ea1b-48f6-8c57-273b457b2f9c` (Bruno Pires) | `GET /rest/api/3/myself` (2026-11-09) |
| Comment rules | Plain text only — this project rejects ALL inline marks in comments (skill §Site 3, bisected IR-29) | skill |

## Summary

The 2026-11-09 DEV outage (hub served the SPA but every API route 503'd for hours) had one root cause — the Postgres LXC rootfs hit 100% — and two visibility failures: nothing watched the disks Irori itself depends on (hub container, DB host), and when the DB went down the UI silently rendered lying empty states ("NO NODES YET") instead of telling the operator what was wrong and what to do. Node disks, by contrast, are already collected, ruled on, and rendered — but their findings never surface anywhere an operator looks by default, and nothing suggests an action.

This epic adds: (1) a hub-filesystem disk metric and a database-availability metric to the existing health rules engine, (2) a global notification surface in the web that turns open findings into banners with CTAs, wired to the already-emitted-but-ignored `health` SSE events, and (3) CTA deep-links that reuse the existing cleanup machinery ("Clean up disk — est. +N GB") for node disks and a runbook hint for infra disks.

## Current state (evidence)

### Node disks: collected, ruled, rendered — but findings go nowhere an operator looks

- Agent collects per-mount storage via `statfs` (`apps/agent/src/collector.ts:678-710`: `totalBytes`, `usedBytes`, per device) into `snapshot.storage` (`packages/core/src/snapshot.ts:68-80`).
- Health rule exists: seed **"Disk usage warn"** `disk_pct gte 80 warn, cooldown 3600` (`packages/core/src/health.ts:95`); `metricValue` computes max used-% over mounts (`apps/server/src/health.ts:39-43`). Evaluated per snapshot via `onSnapshot` (`health.ts` service). Findings persist in `health_findings` (`packages/db/src/schema-ops.ts:185-203`), cleared on recovery.
- **The hub already pushes `health` SSE events on finding appear/clear** (`apps/server/src/health.ts:191` `transition()` → `emit({type: "health", ...})`), and supports a **per-rule webhook** (encrypted secret + `alert_channels`, `health.ts:224-251`) and Prometheus gauges (`irori_node_storage_used_bytes`, `apps/server/src/metrics.ts:102-113`).
- **The web ignores the `health` SSE event entirely** — no `case "health"` anywhere in `apps/web/src` (grep 2026-11-09). Findings surface only as NodeDetail header chips (NodeDetail.vue:403, :935-940, filtered `f.nodeId === props.nodeId`, fetched via `GET /api/v1/health/findings`, api.ts:485-495).
- Thresholds feed chip hues: `GET /api/v1/health/thresholds` → `diskWarnPct` consumed by NodeCard DISK row (card-data.ts:137-148, warn hue NodeCard.vue:37-38), CleanupDrawer header chip (CleanupDrawer.vue:184-186), NAS store bar (OverviewView.vue:626-627).
- **Cleanup machinery is CTA-ready**: per-node Cleanup drawer with 8 audit categories and `reclaimableBytes` per category (CleanupDrawer.vue; categories `packages/core/src/hygiene.ts:9-17`; jobs `hygiene-audit|hygiene-clean|hygiene-prevent`, `packages/core/src/jobs.ts:36-39`); the placement capacity-fail flow already renders **"Clean up disk — est. +N GB"** opening the drawer (ServeView.vue:670-692, 1189-1191); a weekly safe-pass scheduler exists (`apps/server/src/index.ts:545-572`).

### Hub + DB: blind spots

- The hub never measures its own filesystem. `metricValue` only reads agent snapshots; nothing calls `fs.statfs` server-side (grep 2026-11-09). The hub container lives on the docker VM whose disk "fills with docker build cache" (`docs/…/irori-dev-deploy` ops notes) — exactly the failure class that bit us.
- The DB host's disk is invisible: Postgres exposes no free-space function over SQL; no agent runs on the pg LXC. The hub does know `dbHealthy` (AppDeps, used by routes for 503s) but emits no finding/event when it flips.
- **Degraded-DB UI**: every OverviewView fetch swallows failures ("card stays empty", OverviewView.vue:286-316) and the nodes section falls into the "no nodes yet" ghost (OverviewView.vue:578-581) — the exact lie in the incident screenshot. `live.ts:318-319` records the same failure class being fixed for the SSE path only ("misleading 'no nodes' banner"). The web never polls `/healthz` (grep: no healthz in apps/web/src).

## Gap analysis

| # | Gap | Consequence |
|---|---|---|
| G1 | No hub-filesystem disk metric | The container/VM disk Irori itself runs on (and that build cache fills) can hit 100% with zero warning |
| G2 | No database-availability signal into the notification pipeline | A DB outage is invisible to webhooks/Prometheus; the UI has nothing to render |
| G3 | Web drops `health` SSE events; findings poll is NodeDetail-only | An operator on Overview never learns about any finding until they open a node page |
| G4 | Findings carry no suggested action | Even when seen, "Disk usage warn: 84.3 ≥ 80" doesn't say what to do; the reuseable CTA exists only in the placement flow |
| G5 | DB-degraded renders lying empty states | "NO NODES YET" during an outage invites wrong operator actions (e.g. re-registering the NAS) |

## Proposed design

**Decision: extend the existing health rules engine (IR-160/IRI-069) rather than build a new notification channel, and surface findings through one global banner component driven by the already-emitted SSE events.**

- **S1 — `hub_disk_pct` metric (server).** The hub measures its own filesystem with `fs.statfs` (Node 24 builtin; same primitive the agent already uses, collector.ts:687) on a configurable path (env `HUB_DISK_PATH`, default `/` — in the container that is the container filesystem). Evaluate in the 30 s sweep via a dep-injected gauge, exactly the IR-189 `clock_cap_drift` template (`health.ts` sweep + `opts.clockDrift`): new core metric id + seed rule "Hub disk warn" (`gte 80`, warn, cooldown 3600; operator-tunable like every rule). Fleet-scoped: finding `nodeId = null` → wire `""` (already tolerated, `health.ts findings()`), which NodeDetail's per-node filter ignores safely. No schema change (findings rows already allow null nodeId), no new route, no new credentials. Rejected alternative: measuring inside the request path (hot I/O per request); rejected: shelling out to `df` (the agent moved off it deliberately, collector.ts:3).
- **S2 — `db_unavailable` metric (server).** Sweep evaluates the existing `dbHealthy` dep (1/0) as a fleet-scoped rule; seed "Database unavailable" (`eq 1`, critical, cooldown 600). Gives webhooks, Prometheus, and the UI the outage signal from one code path. Rejected: probing from the web via `/healthz` polling — it dies exactly when the hub is unreachable and can't fire webhooks; the hub-side rule covers the "hub up, DB down" case that actually happened, and if the hub is down the agent-online/telemetry-gap rules already fire.
- **S3 — Global banner surface (web).** One `InfraBanner` component on the Overview (the landing page, same position language as `fleetError`): lists open infra findings (empty `nodeId`) — "Database unavailable — data views are stale; check the pg host disk / hub logs" and "Hub disk at N% — free build cache on the deploy VM, or prune the dev DB" (plain runbook text; no hub-side exec — adding remote exec would be a security-sensitive change deliberately out of scope) — plus one row per node-disk finding with a real CTA. Live wiring: handle `health` SSE events in `live.ts` (re-fetch findings on transition, throttled) + one boot fetch. Data source stays `GET /api/v1/health/findings` — no new endpoint.
- **S4 — Node-disk CTAs (web).** For a `disk_pct` finding on node X, the banner row links to `/node/<id>` (cleanup drawer reachable from the existing "Disk hygiene" button, NodeDetail.vue:972-975) and shows the ServeView-style **"Clean up disk — est. +N GB"** inline when `GET /api/v1/nodes/:id/cleanup` has reclaimable categories (reuse ServeView.vue:676-688 hygieneOffers pattern). DB-host disk honesty: Postgres cannot report host free space over SQL and Irori has no agent there — a true pg-host df needs an infra-side probe (cron + webhook) or an agent on that host; **deferred as an open question** (S2's availability signal plus the banner runbook text is the stopgap).
- **Rollout/kill switch:** every rule is `enabled`-toggleable in the health UI/API and metrics respect `metrics_enabled`; the banner is presentation-only. No DB migration, no new routes, no new secrets. Order stories S1 → S2 → S3 → S4 (S3 consumes both metrics; S4 is additive CTAs).

### Architecture impact

No ADR: no data-model, boundary, deployment, or credential change — new metric ids and presentation follow the accepted IR-160/IRI-126 patterns. If the owner later opts into an agent or cron probe on the pg host, that decision needs its own ADR (new integration + trust boundary).

## Phased delivery plan (epic + stories)

**Epic — "Disk-pressure and degraded-database visibility with operator CTAs"** (Epic `10021`). Goal: an operator glancing at the Overview learns about disk pressure or a degraded database before it takes the API down, with a suggested action in reach.

- **S-A (Task, High) — `hub_disk_pct` health metric + seed rule.** Hub `statfs` gauge on `HUB_DISK_PATH` (default `/`), evaluated in the 30 s sweep as a fleet-scoped rule; seed "Hub disk warn" gte 80 warn; core metric enum + thresholds doc updated. AC: finding appears/clears in `GET /api/v1/health/findings` when a fake gauge crosses the threshold; webhook + Prometheus unaffected; no per-request I/O.
- **S-B (Task, High) — `db_unavailable` health metric + seed rule.** Sweep evaluates `dbHealthy` → critical finding on `eq 1`, clears on recovery; seed rule + metric id. AC: with `dbHealthy → false` the sweep opens a fleet finding and emits the SSE/webhook transitions; degraded routes still 503 (no behavior change).
- **S-C (Task, High) — Global infra banner + live findings (web).** `InfraBanner` on Overview rendering open infra findings (S1/S2) with severity hues; `live.ts` handles `health` events (throttled findings re-fetch) + boot fetch; mount tests per the IR-175 ratchet. AC: banner shows "Database unavailable" text when the finding exists, hidden when none; zero console errors; 320/390 px clean.
- **S-D (Task, Medium) — Node-disk CTA rows with est. reclaim (web).** Node-disk findings render banner rows deep-linking to the node and, when the cleanup audit reports reclaimable categories, the "Clean up disk — est. +N GB" affordance (ServeView idiom). AC: banner row for a seeded disk finding links to `/node/<id>`; est. text only when `reclaimableBytes > 0`; no drawer auto-dispatch (audit read-only).
- **S-E (Task, Low) — Docs + ops runbook strings.** SPEC health section + API.md metric list + the banner's runbook copy (what to check on the deploy VM / pg host). AC: docs-check green; the banner's hint text matches the ops runbook.

Effort estimates: owner's call (none fabricated).

## Risks & open questions

1. **DB-host disk remains blind** (accepted gap): `db_unavailable` fires only once the DB is already unusable; a pg-host disk probe needs infra work (cron → rule webhook, or an agent on 102 = new trust boundary + ADR). Owner decision, deferred.
2. **`HUB_DISK_PATH` semantics in docker**: statfs inside the container reports the container filesystem — correct for the build-cache failure class, but it will NOT see the pg host's disk (that is S2/open-question territory, not a bug).
3. **Findings `nodeId` contract**: infra findings use `nodeId = null` (wire `""`). Verified tolerated server-side (`health.ts findings()`) and safely ignored client-side (NodeDetail filters by exact node id), but S-C must assert the banner skips empty-nodeId findings from node-scoped rendering. Any other consumer of `findings()`? Only NodeDetail today.
4. **Sweep cadence vs statfs cost**: one statfs per 30 s is negligible; still, gauge failures must resolve to "not measurable" (null → rule skipped), matching `metricValue` semantics.
5. **Banner noise**: cooldowns (1 h warn / 10 min critical) already bound re-notifies; the banner renders open findings, not every notify, so it stays stable.

## Jira overlap findings

- Searched 2026-11-09 (REST `search/jql`, `nextPageToken` pagination): **0 open issues** matching `text ~ "disk"`, `"notification"`, `"banner"`, `"monitoring"`; **0 open epics** in IR.
- Prior art (all Done): **IR-160** "IRI-069 — Health findings rules engine, alert notifications, Prometheus export" (the engine this epic extends — will `Relates`-link), **IR-130** "Disk hygiene: scope staging cleanup to the store node", IR-179 (restart-storm detection — the sweep-rule template), IR-176/IR-197 (UI feedback rounds).
- No existing ticket duplicates this work; a new epic + 5 tasks is the clean shape.
