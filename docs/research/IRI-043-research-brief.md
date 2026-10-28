# IRI-043 research brief — push concurrency, layered overlays, telemetry transfer labels

- **Date:** 2026-10-28
- **Ticket:** IRI-043 (IR-121)
- **Goal:** three owner asks made against the live placement drawer and Overview page:
  1. DGX↔DGX pushes should use 4 concurrent transfer jobs by default.
  2. Clicking **Push** opens a second modal on top of the placement modal — secondary layers (job output, destructive confirm) should become drawer-native instead of stacked modals.
  3. The Overview **Telemetry** feed shows transfer progress lines without saying which model is transferring.

Evidence is current `main` = 69e4d22, clean tree, deployed hub `dev-0.3.0-51` at 10.20.30.9:3947.

## 1. Push concurrency — is 4 jobs already the default?

**Finding: yes, end-to-end on every live dispatch path — verified against the live hub. The only residual gap is that the agent treats `jobs` as optional, so a push created without the param would silently run modelctl's default (1 stream).**

### 1.1 Dispatch paths all pass `jobs: 4`

| Path | Evidence |
|---|---|
| UI placement drawer **Push** button | `apps/web/src/components/ModelsView.vue:880` (git blame: commit 2234702, IR-101, 2026-10-26): `@click="runJob(row.viaNodeIds[0]!, 'push', { name: selected, hosts: [row.node.cacheUser ? \`${row.node.cacheUser}@${row.node.host}\` : row.node.host], jobs: 4 })"` |
| Setup model staging (`pushStage`) | `apps/server/src/setups-service.ts:752-756`: `pushStage(..., "push", { name: row.model, hosts: [...], jobs: 4 })` |
| ADR-0014 remediation re-push | `apps/server/src/push-remediation.ts:104`: `deps.jobs.create(event.nodeId, "push", { ...params, _remediated: true })` — preserves the original `jobs` |
| Agent → modelctl | `apps/agent/src/modelctl.ts:367` (`const jobs = num("jobs")`) → `:380 pushPreflightScript({..., jobs, ...})` → `:155` `if (opts.jobs !== undefined) exec.push(\`--jobs ${Math.floor(opts.jobs)}\`)` |

### 1.2 Live-hub verification (2026-10-28)

All three push jobs in `GET /api/v1/jobs?limit=100` carry `params.jobs: 4`:

```
10-28T16:03  push canceled  params={"jobs":4,"name":"GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit","hosts":["operator@dgx3.lan"]}
10-28T13:24  push succeeded params={"jobs":4,...same...}
10-28T10:47  push succeeded params={"jobs":4,...same...}
```

The succeeded 13:24 job's output (GET /api/v1/jobs/ff09574e-9b61-403b-b292-cfdbafd9c6e9) proves modelctl honored it:

```
push: transferring 94 files (+95 metadata files) to operator@dgx3.lan with 4 rsync streams
```

Sustained ≈250 MB/s per the progress lines (163.6 GiB in ≈9 min).

### 1.3 Upstream modelctl semantics (`~/Developer/modelctl`)

- `src/modelctl/cli.py:1096-1100`: push `--jobs` is `type=_positive_int, default=1`.
- `src/modelctl/remote.py:362-364`: `stream_count = min(max(jobs, 1), len(names))`, files split `names[index::stream_count]` — streams clamp to file count; repeated `--host` distributes streams round-robin over fabric interfaces.
- `README.md:659-664` recommends exactly this shape for node→node: `modelctl push glm-5.3-flash-exl3-q4 --host node-b --jobs 4`.

### 1.4 Scope note — `sync-local` and `--jobs`

`sync-local --jobs` only parallelizes **across queue entries** and modelctl rejects it without a queue (`cli.py:1244-1246`: `--jobs requires --queue`). Within-one-model parallelism exists only on `push` (file chunks) — and hub-initiated `download-queue` jobs already default to 4 (`packages/core/src/downloads.ts:23,37`: `jobs: z.number().int().min(1).max(16).default(4)`). So "4 jobs" is a push-scoped (and download-queue-already-done) concern.

### 1.5 Residual work

`apps/agent/src/modelctl.ts:367` treats `jobs` as optional and falls through to modelctl's `default=1`. Any push created without the param (direct `POST /api/v1/jobs`, future callers) runs single-stream. One-line hardening makes the owner rule structural instead of convention: default `jobs = num("jobs") ?? 4` in the push case. No clash with `sync-local` (§1.4) since it is per-kind.

## 2. Layered overlays — what stacks today, and the options

**Finding: three independent `.drawer-scrim` overlays in ModelsView stack freely; Push/Delete inside the open placement drawer therefore render a second layer. A in-drawer pattern already exists in CleanupDrawer (IR-120).**

### 2.1 Current structure (`apps/web/src/components/ModelsView.vue`)

| Layer | Template | CSS |
|---|---|---|
| Model detail (placement) | `:844` `<div v-if="selected !== null" class="drawer-scrim"><section class="card drawer">` | `.drawer` `:1106-1108` width min(760px,100%) |
| Job output | `:912` `<div v-if="job !== null" class="drawer-scrim"><section class="card drawer" aria-label="Job output">` | same |
| Shared confirm | `:1070` `<div v-if="confirmState !== null" class="drawer-scrim"><section class="card confirm-card" role="alertdialog">` | `.confirm-card` `:1204-1207` |

`.drawer-scrim` is `position: fixed; inset: 0` (`:1097-1105`) and on ≥721px `align-items: center` (`:1243-1246`) — i.e. every "drawer" is a **centered modal** on desktop. Later DOM layers paint over earlier ones at equal z-index, so clicking **Push** (`runJob` `:663-667` → `createJob` → `openJob` sets `job`) opens the job drawer **over** the still-open detail drawer; clicking **Delete from NAS** (`confirmDrawerDelete` `:512-521` → `confirmState`) stacks the confirm-card over it. The detail drawer's own footer hint `:891-893` — verbatim `Sync/push jobs stream output below · deletes apply immediately after their confirmation` — already promises a below/inline shape that the stacking contradicts.

### 2.2 In-repo precedent for non-stacking

`apps/web/src/components/CleanupDrawer.vue:271-277` — the destructive gate is a **typed node-name confirm pinned inside the drawer** (`.hy-confirm` sticky block, `:373-377`), added in IR-120. No second scrim. This is the pattern to reuse.

`NodeDetail.vue:273-277` implements its own delete-modal flow (`deleteTarget`/`deleteCopy`) — a secondary-layer refactor must either include it or explicitly descope it (open item).

### 2.3 Options

| Option | Shape | Tradeoffs |
|---|---|---|
| **A — inline in the hosting drawer (recommended)** | Job output becomes a section inside the detail drawer under the placement table (the hint already says "output below"); destructive confirms become an inline typed-confirm block (CleanupDrawer precedent). Standalone job drawer survives for queue-row opens (no detail drawer open). | Zero stacked layers; reuses an accepted in-repo pattern; mobile behavior unchanged. Slightly more template restructuring in ModelsView. |
| **B — replace, with Back** | Push/Delete close the detail drawer; the job drawer gains a "Back to model" affordance reopening placement. | Cheapest diff. Loses placement context while watching the transfer; still a modal, not a drawer. |
| **C — side sheet** | Job output opens as a true right-side drawer beside the centered placement modal. | Literal "drawer" reading; simultaneous visibility. New DS overlay pattern (no in-repo precedent), most work, two focus/scrim contexts to manage. |

`Design System.dc.html` (cited by the research skill as a local primary source) was **not found** under `~/Developer` or the repo — no DS overlay/sheet pattern could be cited; option C has no DS grounding without locating that file.

Invariant for any option: **at most one scrim layer** (A, B) or explicit side-by-side geometry (C). Confirm-card remains only for contexts with no drawer open (models-page queue rows); drawer-hosted actions move to inline confirms.

## 3. Telemetry feed — where the model name gets lost

**Finding: job params (with the model name) are already in the API seed but NOT in the SSE `job` frame, and the feed label only formats node + kind. Mid-session jobs therefore can never be labeled until page reload.**

### 3.1 Render chain

- `OverviewView.vue:260`: `feed = feedLines(live.events.value, nodeName, 120, (jobId) => live.jobs.get(jobId))`; rendered `:526` as `{{ fmtBucket(line.t, "minute") }} {{ line.text }}`.
- `apps/web/src/overview.ts:349-356` — job-progress case, verbatim:

```ts
const job = jobById?.(event.jobId);
const label = job !== undefined ? `${nodeName(job.nodeId)} · ${job.kind}: ` : `${node} · `;
lines.push({ t: event.serverTimeMs, text: `${label}${event.line}` });
```

Kind only — this produces exactly the screenshot line `DGX-3 · sync-local: 37.03G 56% 111.14MB/s 0:04:11`.

### 3.2 Context availability — seed yes, live frames no

- Seed: `GET /api/v1/jobs` rows parse via `jobInfoSchema` which **includes `params`** (`packages/core/src/jobs.ts:62`), so `JobLive.params` is populated on page load (`apps/web/src/jobs.ts:15-33`, `jobLiveFromSummary`).
- Live: the SSE `job` frame **carries no params** — `packages/core/src/events.ts:84-96` (`jobEventSchema`: nodeId, jobId, kind, status, exitCode, durationMs) and both emit sites `apps/server/src/index.ts:229,234` send exactly those fields. `live.ts:183` then stores `params: existing?.params ?? {}`.
- `refreshJobs()` runs **once at init** (`apps/web/src/live.ts:275`) — no mid-session re-seed. Consequence, verified live: the sync-local running at 16:20 is `Ornith-1.5-122B-EXL3-EAQv1-4-bpw` (its API row shows `params={"name":"Ornith-1.5-122B-EXL3-EAQv1-4-bpw"}`), but a feed viewer who loaded the page before 16:20 sees an unlabeled line.

### 3.3 Fix shape (decision-complete)

1. **Core:** add `params: z.record(z.string(), z.unknown()).default({})` to `jobEventSchema`.
2. **Server:** include `params: e.params` at both `sse.send({ type: "job", ... })` sites (`apps/server/src/index.ts:229,234`) — requires the settle event to carry params (thread through `JobSettledEvent` in `jobs-service.ts`).
3. **Web:** `live.ts` case "job" stores `params: event.params ?? existing?.params ?? {}` (frame wins); `overview.ts` label helper: `params.name` (string, non-empty) for sync-local/push/nas-delete-apply/register-local/…, for `download-queue` the entry count from `params.downloads`, else no suffix. Lifecycle lines (`started`/`succeeded`) get the same label.

Hub→agent job frames already carry params (`packages/core/src/job-messages.ts:10-11`), so this only closes the hub→web leg; agents are unaffected. zod objects strip unknown keys by default, so the schema update is required — a bare server field addition would be silently dropped.

### 3.4 What "more granular" covers

The owner's example is the model name. Hosts (`operator@dgx3.lan`), ETA and per-stream state already appear inside the raw modelctl lines streamed into the feed; duplicating them per-frame client-side adds noise. Scope: **model name on both progress and lifecycle lines**; anything richer (per-stream rows, ETA chips) is a new ask.

## Summary of Findings

1. **Push 4 jobs — already shipped and verified live.** UI (ModelsView.vue:880), setup staging (setups-service.ts:755), remediation (push-remediation.ts:104) all send `jobs: 4`; the live hub shows every push with `params.jobs=4` and modelctl printing "with 4 rsync streams". Residual hardening: default `jobs = 4` agent-side when the param is absent (modelctl.ts:367) so the rule holds for API-created pushes. `sync-local --jobs` is queue-level and out of scope (modelctl rejects it without a queue).
2. **Overlays — stacking is real and structural** (three independent `.drawer-scrim` layers in ModelsView; Push/Delete stack over the placement drawer, contradicting the drawer's own "output below" hint). In-drawer confirm/output has an accepted precedent (CleanupDrawer `.hy-confirm`, IR-120). Owner decision pending between A (inline, recommended), B (replace+Back), C (side sheet); DS source file absent so C has no grounding today. NodeDetail's parallel delete-modal flow needs an include/desc decision.
3. **Telemetry — root cause located, fix is decision-complete.** Job params exist in the API seed but not in the SSE `job` frame; feed label formats node+kind only. Fix: add `params` to `jobEventSchema`, emit it at index.ts:229/234, store it in live.ts, and label progress+lifecycle lines with `params.name` (download-queue: entry count). Verified against the live hub: the running 16:20 sync-local is Ornith-1.5-122B-EXL3-EAQv1-4-bpw and is unlabeled in the feed exactly as predicted.

**Open:** (a) owner pick for §2 shape (A/B/C) and NodeDetail include/desc; (b) whether a per-push jobs override control in the UI is ever wanted (not asked — default-only assumed); (c) `Design System.dc.html` location for any future C-pattern work.

---

## 4. Addendum 2026-10-28 — full overlay review (owner: "more use cases") and the global telemetry drawer

Owner picked **C (side sheet)** for §2, descoped NodeDetail, then added two demands: review EVERY overlay use case before building, and make the telemetry always available as a resizable drawer with a nav/footer CTA. This section is the review; decisions are recorded in `tasks/IRI-043-….md`.

### 4.1 Overlay/stacking inventory — every surface, verified in source

| # | Surface | Primary layer | Secondary layer today | Verdict |
|---|---|---|---|---|
| 1 | Models · placement drawer → Push | detail drawer `.drawer-scrim` (ModelsView:844) | job drawer on a SECOND scrim (ModelsView:913) — the owner complaint | → side sheet on one shared scrim ✔ built |
| 2 | Models · placement → Delete from NAS | detail drawer | confirm-card stacked (`confirmDrawerDetail` ModelsView:512) | → inline confirm `host:"placement"` ✔ built |
| 3 | Models · job panel → Cancel job | job panel | confirm-card stacked (`confirmDrawerCancel` ModelsView:524) | → inline confirm `host:"job"` ✔ built |
| 4 | Models · download drawer → job opens (retry/open-after-submit, `openJob` at ModelsView:281,376) | dl-drawer | job drawer stacked | → same sheet, automatic (any primary + job) ✔ |
| 5 | Models · queue/catalog rows → confirms | page, no drawer | confirm-card | correct as-is — page-level confirm survives (`host` absent) ✔ |
| 6 | Models · rowpop ⋯ menu | z 30 above scrims, outside-click close (ModelsView:1184) | — | correct as-is |
| 7 | Serve · detail → Edit/Duplicate | detail drawer | wizard — `openWizard(selected); closeDetail()` (ServeView:726-727) | already close-then-open, NO stack — no work |
| 8 | Serve · Remove | detail drawer | inline armed confirm (`armedStop === \`rm-${id}\``, ServeView:728) | already inline — no work |
| 9 | Nodes · hygiene | CleanupDrawer | typed confirm inside the drawer (`.hy-confirm`, CleanupDrawer:271-277) | the pattern's precedent |
| 10 | NodeDetail · model delete/register confirms + progress | page | confirm-card scrims (NodeDetail:832,850) | **owner-descoped** 2026-10-28 |
| 11 | NodeModal / HubSettingsModal / UsageView drawers | page | none | no work |
| 12 | Benchmarks / Analytics / Chats | — | no overlays (grep: no `drawer-scrim`) | no work |

Conclusion: **ModelsView held every real offense**; the shared-scrim sheet plus host-scoped inline confirms now covers all of its paths, and no other view stacks. The pre-existing mobile quirk (`body .drawer { visibility: hidden }` without `.is-open` in the global ≤720px rules, app css:318-320, vs ModelsView drawers without `is-open`) is untouched — parity preserved.

### 4.2 Always-available telemetry drawer — feasibility and decision

- The live store is already an app-wide singleton: `apps/web/src/live.ts:344-345` (`export const live = createLiveStore()`), initialized once in `App.vue` `onMounted` → `live.init()`, stopped on unmount. A global drawer reads `live.events`/`live.jobs` with **zero new plumbing**; `feedLines` is pure and reused as-is (now with the §3 labels).
- Chrome layering contract (app css:254-255): footer z 5 < charttip 6 < scrims 10 < topbar 20 → the permanent drawer takes **z 8**: above page + footer, below every modal/scrim, so temporary layers always win.
- `--topbar-h: 64px` (app css:57) anchors the drawer below the topbar.
- **Owner decision: footer CTA** (over topbar icon / both). `TelemetryDrawer.vue`: fixed right dock, draggable left edge (320–720 px, persisted `irori-telemetry-w`), full-width ≤720 px, live/offline chip, IR-109 newest-last auto-scroll, feed cap 200. The Overview card is unchanged; the footer's empty right slot carries the `Telemetry` ghost button.

### 4.3 Implementation map (this task)

Agent default `jobs=4` (§1.5) · `jobEventSchema.params` + both emit sites + `JobStartedEvent`/`JobSettledEvent.params` (§3.3) · `live.ts` frame-preferring merge · `feedLines` `jobLabel()` on progress + lifecycle lines · ModelsView shared-scrim sheet + host-scoped inline confirms · `TelemetryDrawer.vue` + footer CTA. NodeDetail restyle remains the only deliberate non-goal.
