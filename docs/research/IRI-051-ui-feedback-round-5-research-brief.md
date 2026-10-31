# IRI-051 research brief — UI feedback round 5: serve wizard clarity + models placement/job panel

- **Date:** 2026-10-31
- **Ticket:** IRI-051 (epic), filed from four owner screenshots (2026-10-29/30) with verbatim complaints.
- **Source:** owner screenshots of (1) the Models placement drawer + sync-local job sheet, (2) the wizard REVIEW step, (3) the wizard MODEL step, (4) the wizard SCRIPTS step.

---

## Screen 1 — Models placement drawer + job sheet ("this UI/UX makes no sense")

### Observed problems
1. **Two same-weight panels compete.** The job sheet is *designed* to dock beside the drawer on one scrim (ModelsView.vue:920-923, `.overlay-row` — and the geometry does fit), but the sheet carries no model/node context, so it reads as a random second modal titled "sync-local RUNNING" that appeared over the placement view. Two "Close" buttons at the same height close different things.
2. **Raw rsync output is the whole show.** sync-local jobs render `job.output.map(o => o.line)` verbatim (ModelsView.vue:1023) — a wall of per-snapshot `progress2` lines (all "0%", per-line ETAs). The download-queue kind already has the right pattern (aggregate `jobSummaryText` + raw collapsed in `<details class="rawlog">`, ModelsView.vue:1013-1021); sync-local/push never got it.
3. **No aggregate progress.** The transfer is "92 files (163.65 GiB)"; the visible lines are cumulative total-progress snapshots (6.96K → 469.82M, increasing bytes) — parseable with `parseTransferProgress` (packages/core/src/setups.ts, exported) into bytes/pct/rate/ETA, but nothing does.
4. **No target context.** The sheet header is `{{ job.job.kind }}` + status chip (ModelsView.vue:1005-1007) — while it runs you cannot tell which node/model it is for.
5. **STATE vs ACTION conflation.** The "Action" column renders `placementChip(row.action)` — a chip whose label IS an action ("sync from NAS", ModelsView.vue:945, models.ts:405-414) — next to a separate button ("Sync"/"Push"/"Delete from NAS", :949-967). State and action read as two competing actions.
6. **No live per-row state** — while the sync runs, the placement rows are static (placement fetched once, :639-664); nothing shows "syncing 12%" on the target row even though the open job polls every 2s (:759-768).

### Redesign (amended after expert review)
- Keep the IRI-043 docking (it already fits: drawer 760px + sheet 430px); fix the **content** confusion instead.
- Sheet header gains target context: `sync-local · on {node} · {model}` (job row carries nodeId/params).
- **Aggregate progress comes from `job.job.progress`** — the hub already parses single-stream progress2 hub-side (IR-131: `transferStreams(...) === 1` → persisted `jobs.progress`, served on GET /jobs/:id and SSE `job-progress`; sync-local is single-stream by default). The web `JobDetail.progress` + live store already carry it — **zero client parsing for the screenshot's case**. Client `parseTransferProgress` is only the FALLBACK for rows with `progress: null`. **Push runs 4 streams → the hub deliberately emits raw-only frames — push sheets stay raw-collapsed with NO aggregate claim** (one stream's stats must never be labeled aggregate). Progress2 lines carry bytes+pct only: no "done/total", no file-count promises; the model bytes come from the placement response when shown.
- Raw output stays available but collapsed (`<details class="rawlog">`), mirroring the existing download-queue block.
- Placement table columns: **Node | State | Action** — Role folds into the Node cell as faint subtext (head/worker context must survive). State chip copy becomes state-shaped: `present` (chip--ok) / `needs sync` (chip--accent) / `needs push` (chip--accent) / `unavailable` (chip--warn) — `placementChip` has one consumer, the copy change is free.
- **Live `syncing N%` chip is driven by the live store** (`live.jobs` via broadcast job/job-progress SSE — independent of the open sheet and the 2s poll) with guards `kind === "sync-local" && status === "running" && params.name === selected && nodeId === row.node.id`; percent-null copy is `syncing…`; push rows intentionally get no live chip (multi-stream → no parsed progress). This survives sheet-close and covers concurrent syncs.
- Single Close per surface stays (closeTopMost already pops the top layer). The two-Close-buttons confusion is accepted for now — the surfaces are visually distinct once the sheet carries context.

## Screen 2 — Wizard REVIEW step ("too noisy; can't see what is important and the env variables in play")

### Observed problems (ServeView.vue:848-857)
1. **Placement is missing**: the review says `cluster — head + 2 worker(s)` — never WHICH nodes. The most important fact of a cluster setup is absent from the final review.
2. **EXTRA_ARGS value is not shown** — the env row lists the token `EXTRA_ARGS` but not `--host 127.0.0.1` (the value only exists on step 3).
3. **Three concepts conflated in one `env` row**: exported vars, capture toggle, bodies toggle — plus an in-row explanation ("$PORT is the loopback engine port").
4. **Constant noise**: `log: streamed into telemetry (ring + persisted run log)` is not a decision; `port` row packs three facts; long script paths wrap and dominate.
5. All rows share one visual weight — nothing distinguishes "what runs where" from metadata.

### Redesign (pure template/data change, no API)
- Grouped sections in the same step: **Runs** (model, kind, placement: head name + worker names with role chips — id→name via the loaded nodes with a short-id fallback when the registry is unavailable, mirroring `cleanWorkerIds` tolerance), **Port & health** (port · timeout 15 m), **Scripts** (start/stop, one mono line each), **Environment** (wrapping chips WITH values: `MODEL_NAME`, `PORT`, `MODEL_PATH`, `EXTRA_ARGS=--host 127.0.0.1`, `capture on`, `bodies kept`).
- Drop the `log` row; drop the loopback explanation from data (it already lives on the capture checkbox).

## Screen 3 — Wizard MODEL step (port defaults to 8080 on edit; order by name; hard to scan)

### Verified facts
1. **PORT BUG (root-caused)**: `wizardPort = ref(8080)` (ServeView.vue:526) and `openWizard` (ServeView.vue:294-331) never assigns it — **zero assignments to `wizardPort.value` anywhere**. Edit (ServeView.vue:726) and duplicate (:214-218) therefore submit 8080 (or a stale last-typed value) via `wizardInput()` (:471). Fix: `wizardPort.value = from?.port ?? 8080` in openWizard.
2. **Order**: the picker already requests `sort="name"` (ServeView.vue:388) and the server honors it (`orderBy(modelMeta.name)`, jobs-service.ts:584-586) — but ordering is **DB-collation-dependent**, which splits the `GLM-5.3-Flash-*` family around lowercase entries (the screenshot's `glm-5.3-flash-dflash2` sits between two uppercase families). The Models page independently defaults to "Recently added ↓" (ModelsView.vue:45, toggle :825-827).
3. **Scanability**: one radio card per model in a 320px scroll area (~4 visible), runtime+size chips only; 147 models with no presence context.

### Redesign (amended after expert review)
- **Picker window**: loop-fetch remaining pages (147 rows ≈ 6 requests, web-layer only) and sort **client-side** with `name.localeCompare(other, undefined, { numeric: true, sensitivity: "base" })` — collation-proof, numeric-aware (2.75bpw < 4bpw < 10bpw), family-adjacent; without the loop the 25-row window would still be DB-collation-selected. Picker order may differ from the Models page DB order — different surfaces, stated.
- Models page: **default stays "Recently added"** (new downloads belong on top) but the toggle choice **persists in localStorage** — the owner flips to Name A–Z once and it sticks. (The picker was the complaint; the page flip is deliberately not a default change.)
- Picker density: two-column compact rows (name bold, repo muted second line, runtime+size chips right), same radio semantics; search unchanged. Explanations stay as short `.stat__sub` subtext (DS-native); no native `title` tooltips.

## Screen 4 — Wizard SCRIPTS step ("ask for a recipe folder and then for the start stop")

### Observed problems (ServeView.vue:787-808)
1. Two full-path inputs duplicate the recipe directory; the owner's real workflow is one folder + start/stop script names (screenshot: `~/developer/recipes/GLM-5.3-…-TensorFold/start-tp3.sh` + `…/stop.sh`).
2. The env-export checkboxes are four full-width cards with long helper text — the step reads as a wall.

### Redesign (amended after expert review)
- **Recipe folder** input (path on the head) + **Start script** / **Stop script** name inputs. **Compose precedence**: a name that is path-shaped (starts with `/` or `~`, or contains `/`) is used **verbatim, folder ignored**; else trimmed folder + `/` + name; empty folder → name as-is. This makes "paste a full path into the name field" always safe.
- Edit/duplicate prefill via a pure `splitRecipePaths(start, stop)`: shared dirname → folder + basenames; differing dirnames → folder empty and both name fields carry the full paths (compose passes them through unchanged). Round-trip identity `compose(split(p)) === p` is a named unit test.
- The step-3 **required-check moves to the composed values** (`nextStep` today checks raw `wizard.scriptStart`) so folder-only/name-only states can't slip through; composed paths keep the existing 1024-char cap surfaced via wizardError.
- "Validate on head (test -x)" unchanged (validates the composed paths; result chips stay).
- Env exports compacted into a 2-column checkbox grid with shortened one-line subtext; EXTRA_ARGS input inline under its checkbox; capture/bodies one-liners (long explanations trimmed — DS-native `.stat__sub`, no native `title` tooltips).

## Out of scope
- No API/contract change (placement response, setup schema untouched) — all five stories are web-layer.
- No new wizard steps; step count and order stay.
- The persistent op bar (IR-131) and TransfersDock stay as-is.

## Verification plan
- Pure helpers (`splitRecipePaths`/`composeScriptPath`, sync summary parser, placement-name lines) unit-tested in apps/web/test (repo convention: pure-helper tests + chrome-markup source pins).
- Fixture browser verification of all four surfaces on the built dist (screenshots light+dark where visible), plus `pnpm -r test`, `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check`.
