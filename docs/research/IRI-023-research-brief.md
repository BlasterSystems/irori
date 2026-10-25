# IRI-023 research brief — Overview v2: serving-process cards, node list, cadence, energy

- **Date:** 2026-10-24
- **Ticket:** IRI-023 (task file to be created; Jira story not yet cut — next IR-NN)
- **Goal:** Owner feedback round on the Overview page (http://10.0.10.9:3947, dev-0.3.0-26). What the implementation depends on: the real data-update interval, energy-data availability on GB10, current hero/workers/lens structure, the measured spacing bugs, and smoothing options.

Method: code reading plus live probes against DEV — `GET /api/v1/nodes/:id/snapshot` for DGX-1/DGX-2 and a driven Chromium session (viewport widths 1568/1280/1000/820) measuring the rendered layout.

## 1. What is the data update interval?

**Answer: 2 s for hardware snapshots and head LLM probes; 10 s detect-only for workers; the hub relays to the browser over SSE immediately; the Overview's secondary cards poll every 60 s.**

Evidence:

- Agent hardware cadence: `DEFAULT_CADENCE_MS = 2000` (`apps/agent/src/config.ts:37`). The server hands its own `cadenceMs` to every agent in `hello-ok` (`apps/server/src/hub.ts:252`) and `config-update` (`hub.ts:129`).
- Server cadence is **hardcoded**: `cadenceMs: DEFAULT_CADENCE_MS` with `DEFAULT_CADENCE_MS = 2000` (`apps/server/src/config.ts:24,49`) — no env override exists.
- LLM probe cadence is role-derived in the config-update: `LLM_PROBE_CADENCE_MS = 2_000` (heads/standalone), `LLM_DETECT_CADENCE_MS = 10_000` (workers, detect-only) (`hub.ts:48-50,131`).
- Delivery: the hub fans every snapshot/LLM frame to the rings + SSE on arrival (`hub.ts:108-114` doc); the web store consumes `EventSource("/api/v1/events")` (`apps/web/src/live.ts:213-214`). No polling for live values.
- Overview-only polls: `refreshCards()` (power analytics + NAS model count) and `refreshSpark()` (24 h LLM history) run every **60 s** (`OverviewView.vue:100-105`).
- The footer already has a freshness signal available: `lastEventAgeMs` ticks every 1 s in the live store (`live.ts:62,87`).

Options for showing the interval on the bottom bar:

| Option | Change | Tradeoff |
|---|---|---|
| A. Static copy "updates every 2 s" | Footer text only | Breaks silently if cadence ever becomes configurable |
| B. Extend `GET /api/v1/version` with `cadenceMs`; footer renders it | Server version payload + `apps/web/src/version.ts` | Small, honest, survives config changes |
| C. Make cadence env-configurable (`CADENCE_MS`) **and** B | `loadConfig` + version payload | Only if the owner wants the interval adjustable; persistence/agent-restart semantics follow |

Recommend B (display-only); C is a separate decision.

## 2. Is energy-consumption data available?

**Answer: yes for GPU board power on every spark — verified live. CPU package power is unavailable on GB10 (null), and `power.limit` is N/A. A fleet "now" wattage can be computed client-side from live snapshots; kWh integration already exists for the monthly archive.**

Live evidence (DEV API, 2026-10-24 ~18:08Z, engine under load):

| Node | `gpus[0].powerW` | `gpus[0].usagePct` | `powerLimitW` | `cpu.packagePowerW` |
|---|---|---|---|---|
| DGX-1 (head) | **35.55** | 93 % | null | null |
| DGX-2 (worker) | **31.32** | 94 % | null | null |

- The collector queries `power.draw,power.limit` (`apps/agent/src/collector.ts:187-193`); `powerW: parseNonNegNumber(fields[2])` (`collector.ts:272`). So GB10 *does* answer `power.draw` — the earlier "GB10 package-power verify deferred" question is now closed.
- CPU package power is null on both sparks: RAPL is Intel-only (`/sys/class/powercap/intel-rapl:*`, `collector.ts:455-471`) and the hwmon fallback found no power sensor on Grace.
- Consequence for the UI: the worker-card `PKG` row renders only when `cpu.packagePowerW !== null` (`apps/web/src/card-data.ts:136-148`) → **no watts appear on node cards today**, although `gpus[].powerW` flows. The GPU row (`card-data.ts:98-113`) prints name/util/mem but not watts.
- The Power card's formula, already server-side: `watts = min(gpu + cpu + 40, 240)` per node-bucket (`apps/server/src/analytics.ts:166-171`); constants `GB10_SOC_TDP_W = 140`, `GB10_SYSTEM_ENVELOPE_W = 240`, `DEFAULT_BASE_OVERHEAD_W = 40` (`packages/core/src/analytics.ts:132-134`).
- Monthly energy (Wh) integration exists (M7): `apps/server/src/energy.ts:6-11,51-52` — per-hour buckets, gpu+cpu+base clamped to the envelope, offline hours contribute nothing.

Options for the bottom bar / workers section:

| Want | Source | Freshness |
|---|---|---|
| Fleet "now" watts in footer | Sum per node from `live.snapshots`: `gpuW + cpuW + 40`, clamp 240, skip nodes without readings — same math as analytics.ts:168 | 2 s (SSE) |
| Per-node watts on node cards | Append `fmtWatts(gpu.powerW)` to the GPU row in `card-data.ts` | 2 s |
| Fleet kWh | Energy monthly archive (per-node Wh) | hourly buckets |

Recommend footer = fleet-now W from live snapshots (App.vue already imports the live store); GPU-row watts ride the same data.

## 3. How are serving processes represented today (hero), and what does one-card-per-process take?

- The hero is anchored on the **first head only**: `headNode = groupNodes(sortedNodes).heads[0]` (`OverviewView.vue:33-35`); metrics come from `pickPrimaryPort` over that head's probed ports (`overview.ts:31-56` — serving ports first, busiest decode wins). A serving engine on a non-head node never gets a hero; two engines on one head (dgx1 probes 8080 **and** 8081) show only the primary.
- The natural identity for "one card per serving process (single node or cluster)" is the **setup registry**: `SetupInfo { id, kind: single|cluster, model, port, headNodeId, nodes[], status, health }` (`packages/core/src/setups.ts:42-69`). A running setup = one serving process; `kind` distinguishes single vs cluster. Engines detected on probed ports but not setup-managed are the fallback case (current hero shows them via `pickPrimaryPort`).
- Chart: `refreshSpark()` fetches range **"24h"** (`OverviewView.vue:64-79`) → hourly buckets (`apps/server/src/history.ts:22-27: "24h" → "hour"`), and renders at **height 36** (`overview.ts:107` default `height = 36`). Browser-measured on DEV: `heroSpark` height attribute `36`, rendered 36 px — the squash the owner saw.
- 30-minute window options:

| Option | Change | Tradeoff |
|---|---|---|
| A. Add `"30m"` to `HISTORY_RANGES` (`history.ts:6,14-28`, minute granularity) | Server + client | Clean contract; benefits node detail too; touches both `/history` and `/llm/history` validation (`app.ts:354,587`) |
| B. Fetch `"1h"` and client-trim to the last 30 points | Client only | No server change; minute buckets already exist for 1h (`history.ts:24`); slight overfetch |

Minute buckets and the raw-snapshot fallback for fresh deploys already exist for the 1h/minute path (`apps/server/src/llm-history.ts:55-57`), so both options render immediately after deploy. Height is a call-site param (`heroSpark(points, width, height)`, `overview.ts:107`); LensChart uses `preserveAspectRatio="none"` so the viewBox scales to the rendered height.

## 4. Why NAS appears under "Workers"

- Cluster-lens node list: `rest = [...groups.workers, ...groups.standalone]` (`OverviewView.vue:52`); `groupNodes` buckets by **role**, and the NAS has role `"standalone"` (`apps/web/src/llm-data.ts:175-186`) → the NAS card is listed under the "Workers" heading (confirmed in the owner's screenshot), while it also has its own store card in the hero side stack.
- Fix shape: the section becomes "Nodes" = every `kind === "spark"` node **including heads** (drop the hero-replacement rule), excluding `kind === "nas"`. NodeCard already renders the right rows per kind (`card-data.ts:150-165`) and the head's inference summary line.

## 5. The top filter (lens segment)

- The seg is the lens switcher: `Cluster · <model>` / `All fleet` / one button per node (`OverviewView.vue:27-28,40-44`, rendered at `:184-188`). Removing it touches: `lens` ref, `lensOptions`, `lensNodes`, `sectionTitle` (`:59-65`), and the `lens === 'cluster'` gating of hero/side cards.
- Navigation is not lost: per-node pages remain reachable via NodeCard links (`#/node/:id`, `router.ts:6`) — the seg's per-node buttons are redundant for that.
- With the lens gone, the NAS store card and Power card (currently side-stack of the cluster hero, `OverviewView.vue:193-232`) need a permanent home independent of the hero.

## 6. Spacing bugs — measured

Driven-browser measurements on DEV (`.cols-3` = workers grid, Telemetry = the feed section):

| Viewport | container left/right margin | container computed padding-x | gap workers→Telemetry |
|---|---|---|---|
| 1568 | 184 / 184 | **0 px** | **0 px** |
| 1280 | 40 / 40 | **0 px** | **0 px** |
| 1000 | **0 / 0** | **0 px** | **0 px** |
| 820 | **0 / 0** | **0 px** | **0 px** |

- Root cause (horizontal): `.container { padding: 0 24px }` (`irori.css:76`) is clobbered on the same element by `.page`'s shorthand `padding: var(--space-5) 0 var(--space-7)` (`irori.css:77`) — `main.container.page` (`App.vue:90`) ends with **zero horizontal padding** at every width; only the 1200 px max-width centering remains. Fix: restore horizontal padding in `.page` (24 px; 16 px in the ≤720 tier per `irori.css:283`). Global but uniform — every page renders inside this element.
- Root cause (vertical): the workers `section.cols-3` has no bottom margin and the Telemetry `section.card` only `margin-bottom: 12px` (`OverviewView.vue:264`) → measured gap 0. Fix: margin between stacked sections (or a shared section rhythm).

## 7. Smoothing value changes

- Bars: `.bar__fill` has **no transition** (`irori.css:177`). A single rule — `transition: width .5s ease` — smooths every barrow fleet-wide (node cards, Power, NAS, disk). Gate behind `prefers-reduced-motion` (pattern exists at `irori.css:161`).
- Stat numbers: text swaps every 2 s; CSS cannot tween text. A tiny rAF-tween composable for `stat__value` is optional polish; the bars are the visible offender.
- Charts: `LensChart` receives a fresh `chart` object per refresh and renders `<path :d>`; CSS `transition: d` is Chromium-only today. Universal smoothing needs JS path interpolation (watch points → rAF) — real code for a chart that (hero) refreshes every 60 s. Recommend: bars via CSS now; chart tween only if the 2 s cadence ever reaches charts.

## 8. The "60m window" label is not a real window

- The hero's ITL p95 sub-label `60m window` is hardcoded template copy (`OverviewView.vue`, ITL stat). The actual p95s are **engine-histogram quantiles** sampled every probe pass — `promHistogramQuantile(..., 0.95)` over e.g. `q27_ttft_seconds` / `q27_itl_seconds` (`apps/agent/src/llm-probe.ts:543-546,922-924`; vLLM-shaped engines `:590-592`). The window is whatever the engine's histogram covers, not a hub-side 60 m. Honest fix: correct or drop the sub-label; a real hub-side rolling p95 would be a new feature.

## 9. Addendum (2026-10-24, evening): the recurring "MODEL_PATH resolution failed" feed line

Owner quote: `19:32 setup · stopped · MODEL_PATH resolution failed for glm-5.3-flash-exl3-q4 (modelctl path --local)`. Three stacked causes, all verified live.

### 9.1 The error itself: the model is not on the head's local store

- The setup row (id `69916930-c6d5-4d4a-98e7-2d05ed7c74d8`, name/model `glm-5.3-flash-exl3-q4`, kind cluster, head DGX-1, port 8080, `env.modelPath: true`) carries `lastError: "MODEL_PATH resolution failed for …"` and `lastStartedAt: null` — every start is refused before any run is spawned.
- `GET /api/v1/placement?model=glm-5.3-flash-exl3-q4`: **present on the NAS only**; DGX-1/2/3 all `action: "sync"`. The 187.6 GB object (`0xSero/GLM-5.3-Flash-EXL3-Q4`) is in the catalog but has never been synced to a spark.
- On start the server sends `setup-start` with `modelPathName` and **no pre-flight placement check** (`apps/server/src/setups-service.ts:410-452`); the head agent resolves `MODEL_PATH` via `modelctl path --local <name>` — local store only — and refuses pre-spawn on failure (`apps/agent/src/setups.ts:257-261,546-555`). Staging exists (`POST /setups/:id/transfers`, the "NAS first, then the cluster" chain, `setups-service.ts:655-737`) but is a separate explicit step; `start()` never chains it.

### 9.2 The repetition: the ticker re-announces unchanged state every 15 s

- Not repeated start attempts — the live SSE log shows identical `setup-state` frames at exactly 15000 ms deltas (`1792866323645 → 1792866338644 → 1792866353648 …`).
- Mechanism: the setups ticker polls driver truth every `DRIVER_POLL_EVERY (3) × SETUPS_TICK_MS (5 s) = 15 s` (`setups-service.ts:630-634`); the agent replies from its recorded driver state; `onDriverEvent` ends in an **unconditional** `announce()` (`setups-service.ts:595`) → one `setup-state` SSE event and feed line every 15 s with the same status/lastError. With the feed capped at 30 lines the Telemetry panel is just this line, forever.
- Fix: dedupe — skip `updateRow` + `announce` when `(status, health, lastError)` are unchanged (also removes a pointless DB write every 15 s).

### 9.3 The setup row is also corrupt: duplicate workers, including the NAS

- The row's `nodes` array: DGX-3 ×4, NAS ×2, DGX-2 ×1 (`GET /api/v1/setups`).
- Wizard checkbox handler bug: `@change="n.id in wizard.workerIds ? … : …push(n.id)"` (`apps/web/src/components/ServeView.vue:744`) — `in` on an array tests index keys; a UUID string is never a key, so the test is always false, every toggle pushes, and the uncheck branch is dead code. Six clicks → six entries. (The sibling bindings on the same element use `.includes` correctly.)
- The NAS is offered as a worker candidate because the list only filters out the head (`nodes.filter((x) => x.id !== wizard.headNodeId)`, `ServeView.vue:743`).
- The server accepts anything: create inserts `input.nodes` verbatim (`setups-service.ts:366`), patch replaces verbatim (`:386`) — no dedupe, no existence/kind validation.
- Fix: `.includes` in the handler; exclude `kind === "nas"` from worker candidates; validate server-side at create/patch (dedupe by nodeId, reject unknown ids, reject NAS and the head itself).

Plan consequences: (1) start pre-flight — refuse with actionable copy or auto-stage before `setup-start`; (2) announce dedupe in `onDriverEvent`; (3) wizard handler + worker-list filter; (4) server-side setup-nodes validation. Items 2–4 are small; item 1 is a UX decision (refuse vs auto-stage 187 GB on a click).

## 10. Addendum: delete from the NAS without the mandatory dry-run

Owner decision: UI deletion needs only a user confirmation of the destructive action — the dry-run-first flow is not required.

- Current flow (IRI-018): confirm modal → `nas-delete` dry-run job (`modelctl delete <name> --root …`, `apps/agent/src/modelctl.ts:163-167`); only a **succeeded** dry-run unlocks "Arm delete (APPLY)" in the job drawer (`nas-delete-apply` = `delete … --apply --yes`, `modelctl.ts:168-172`); armability is computed by `armableNasDelete` (`apps/web/src/models.ts:348-355`). Entry points and copy: `ModelsView.vue:417-421,475-480,527-561,841-848,891-894`. Rationale (`modelctl.ts:8-10`, ADR-0004): Irori never mutates the store except through modelctl; destructive kinds are separate dry-run/armed jobs.
- Plan: the confirm modal's danger action runs `nas-delete-apply` **directly**; remove the arm-from-drawer flow (`armableNasDelete`, `jobDeleteName`, `armNasDelete`, the drawer arm row, the "Delete (dry run)" labels and footer copy) and the `nas-delete` dry-run kind from the job menu. ADR-0004 stays intact — the direct path is still a modelctl invocation (`--apply --yes`).
- Keep: the setup-advisory banner (`deleteSetupWarn` — warn when the model is referenced by setups) and the hygiene drawer's own dry-run flow (`CleanupDrawer.vue` — a different feature, explicitly out of scope).
- Tests: `apps/web/src/test/nas-delete.test.ts` and the `armableNasDelete` export disappear with the flow.

## 11. Addendum (2026-10-24, night): clicking a textbox in the Edit-setup wizard closes the modal

**Reproduced and mechanism proven in a driven browser on dev-0.3.0-26.**

- Repro: on wizard step 3, press the "Start script" input (center), drag ~60 px, release over the dark area **outside** the modal → the wizard closes. Press+release both inside never closes it (verified: every textbox on every step, single + double click, viewports 1421×1568 and 1421×1000 — all stayed open).
- Mechanism: the browser fires `click` on the **common inclusive ancestor of the press and release points**. Press on the input, release on the backdrop → the click lands on `.drawer-scrim`, and the scrim's `@click.self="closeWizard"` (`apps/web/src/components/ServeView.vue:719`) treats it as a backdrop click. The start/stop script inputs end ~18 px from the modal's edge, so any small trackpad drift during release closes the modal — exactly the owner's report.
- The same `@click.self` pattern guards 7 surfaces, all with the identical latent bug: setup detail drawer (`ServeView.vue:669`), setup wizard (`:719`), disk-hygiene drawer (`CleanupDrawer.vue:194`), hub settings (`HubSettingsModal.vue:49`), node modal (`NodeModal.vue:117`), request-detail drawer and client-keys drawer (`UsageView.vue:569,597`).
- Fix: close on backdrop click only when the **press itself started on the scrim** — record `mousedown.target` and close on `click` only if it was the scrim on both ends. One shared helper (directive or handler factory), applied to all 7 surfaces; ✕ buttons unchanged. Verification: the press-input/release-scrim repro must keep every surface open; press+release on the backdrop must still close.

## 12. Addendum: no ticket/ADR references in frontend UI copy

Owner rule going forward: **the UI never shows ticket numbers, milestone tags, or ADR references** (code comments are unaffected). Known visible occurrences to remove:

- `ServeView.vue:787` — checkbox label "Capture usage (M8)" → "Capture usage"
- `ServeView.vue:788` — checkbox label "Keep bodies (IR-52)" → "Keep bodies"
- `ChatsView.vue:107` — page subtitle "Reconstructed conversations from retained request bodies (IR-53)."
- `UsageView.vue:310` — page subtitle "Captured LLM traffic through proxy-flagged setups (ADR-0008)."

Sweep method: grep `apps/web/src` for `\(M\d\)|IR-\d|IRI-\d|ADR-\d` and keep only hits inside visible template text / aria-labels / placeholders / titles (template HTML comments and `.ts` comments stay). Chrome-markup tests that assert copy strings must be updated in the same change. All new copy written in this task (footer, hero, confirms) follows the same rule.

## Summary of Findings

1. **Update interval = 2 s** (hardcoded server const handed to agents on hello; workers probe LLM detect-only at 10 s; SSE delivers immediately; Overview's power/NAS/spark poll 60 s). Footer display: extend `GET /api/v1/version` with `cadenceMs` (option B); `lastEventAgeMs` is already available if "last update Xs ago" is wanted.
2. **Energy data is live-verified available**: GPU `powerW` on all sparks (35.55 W / 31.32 W under load); CPU package power and `power.limit` are null on GB10. Fleet-now watts for the bottom bar = client-side sum over `live.snapshots` (gpu+cpu+40, clamp 240); GPU-row watts on node cards ride the same snapshot.
3. **Hero → one card per serving process** maps to running `SetupInfo` rows (single vs cluster) plus detected-but-unmanaged ports as fallback. Chart: add a `"30m"` history range (minute buckets already exist) or client-trim 1h; height is a `heroSpark` call-site param (currently 36 px — the measured squash).
4. **Workers→Nodes**: list all spark nodes including heads, exclude `kind === "nas"` (today NAS lands in `groups.standalone` and is listed under Workers).
5. **Remove the lens seg**; per-node navigation stays via `#/node/:id` cards. NAS/Power cards need a lens-independent home.
6. **Spacing bugs are real and measured**: `.page`'s padding shorthand zeroes the container's horizontal padding (0 px at all widths; full-bleed ≤1248 px) and the Workers→Telemetry gap is 0 px. Both are one-line CSS fixes.
7. **Smoothing**: CSS `width` transition on `.bar__fill` (+ reduced-motion gate) covers the visible 2 s jumps; number/chart tween is optional extra code.
8. **"60m window" is hardcoded copy**; p95s are engine-histogram quantiles — fix the label, don't imply a hub-side window.
9. **The recurring MODEL_PATH feed line has three stacked causes** (§9): the model exists only on the NAS while start resolves `MODEL_PATH --local` on the head with no pre-flight; `onDriverEvent` re-announces unchanged state every 15 s (the feed flood — nobody is clicking start); and the setup row itself carries duplicate workers incl. the NAS, caused by a dead `in`-operator check in the wizard checkbox handler plus missing server validation.
10. **Delete from the NAS goes direct** (§10): confirm modal → `nas-delete-apply` (`modelctl delete --apply --yes`) with the existing confirm modal as the sole gate; the dry-run/arm UI flow is removed; ADR-0004 (modelctl-only writes) and the hygiene dry-run flow are untouched.
11. **Wizard close-on-textbox-click is a press/release split bug, reproduced** (§11): the browser fires `click` on the common ancestor of press and release points; press on an input + release on the backdrop lands on the scrim and `@click.self` closes it. Seven surfaces share the pattern; fix = close only when the press started on the scrim.
12. **UI copy carries no ticket/milestone/ADR references** (§12): four known visible strings to clean (Serve, Chats, Usage) plus a grep sweep; code comments unaffected.

Open (owner decision): should the interval become user-configurable (option C — env plumbing + restart semantics); the exact hero layout when multiple serving processes run at once (stack vs grid); start pre-flight behavior — refuse with an actionable error vs auto-stage before `setup-start` (§9.1).
