# IRI-124 research brief — UI feedback round 6: node header, clock-cap selects, CPU underclock, chart temperatures, network rows

- **Date:** 2026-11-04 · **Hub:** dev-0.4.0-1 (10.20.30.9:3947) · **Repo:** main (`04e0e1f`)
- **Source:** five owner items with three screenshots (node page DGX-1 header, node History CPU/GPU cards, node page Network/Storage cards), verbatim below.
- **Live evidence:** read-only probes of DGX-1 (`ssh operator@10.20.30.4`, 2026-11-04 21:41–21:45Z): `/sys/devices/system/cpu/cpufreq/*`, `nvidia-smi --query-gpu=clocks.max.sm`, `uptime -s`, file mtimes.

## Jira target

| | |
|---|---|
| Project key | `IR` (name "Irori", project id 10004) |
| Site host | `blastersystems.atlassian.net` (JIRA_EMAIL_BLASTERSYSTEMS + JIRA_API_TOKEN_BLASTERSYSTEMS) |
| Board | **5** — "IR board" (`GET /rest/agile/1.0/board?maxResults=50`, `location.projectKey === "IR"`) |
| Issuetype ids | Epic `10021` · Story `10022` · Bug `10023` · Task `10024` · Subtask `10020` (createmeta, 2026-11-04) |
| Active sprint | **998 "IR Sprint 3"** (`GET /rest/agile/1.0/board/5/sprint?state=active` → `values[0]`) |
| Assignee accountId | `<redacted-jira-account-id>` (`/rest/api/3/myself`) |
| Resolved by | repo convention (`tasks/IRI-NNN-*.md`, `docs/DEVELOPMENT_PROCESS.md`), owner instruction "create tickets on the current sprint", live Jira probe 2026-11-04 |
| Created (2026-11-04) | Epic **IR-180**; tasks **IR-181** (S1 header), **IR-182** (S2 GPU select), **IR-183** (S3 temp overlay), **IR-184** (S4 network rows), **IR-185** (S5 CPU backend), **IR-186** (S6 CPU select) — all in sprint 998, priority Medium, assignee Bruno Pires |
| Brief posted | epic comments 25760 + 25761 (2 parts; this file is the source of truth) |

Comment/description constraints for this project: plain text nodes only (no inline marks), full ADF doc node, `parent` set at creation for children (see `mwa-jira-rest` § "Site 3").

## Owner report

1. *"small UI glitch"* — screenshot 1: the node page title renders one character per line (**D / G / X / - / 1**) and the chip/action row runs past the card edge (`◈ OVERVIEW` clipped).
2. *"GPU underclock should be a dropdown or selection (1800/2000/2200/3000) not open input"* — screenshot 2: the GPU card's `SM cap MHz` free-text input.
3. *"add the same to CPU underclock"* — no CPU control exists today.
4. *"on booth CPU/GPU charts, add temp to the % of GPU/CPU usage"* — the two history sparklines plot only utilization; temperature lives in the sub line.
5. *"UI glitch and create tickets on the current sprint"* — screenshot 3: Network card interface rows (e.g. `enP7s7` with 5 IPv6 addresses) paint outside the card, over the empty right column.

---

## 1. Node header: title collapses, action row overflows

**Observed.** `<h1>` + up to 10 chips + 7 buttons live in ONE `.row` (`apps/web/src/components/NodeDetail.vue:829-884`). Row children: `.pagehead` (`apps/web/src/assets/irori.css:89`) has a single child; `.row` (`irori.css:99`) is `display:flex` with **no wrap** above the mobile tier (wrap is applied only at ≤720px, `irori.css:329-331`); `.chip` (`irori.css:180-181`) and `.btn` (`irori.css:160-161`) are **`white-space: nowrap`**, so their min-content is the full label and they cannot shrink. The `<h1>` (`irori.css:67-68`) is the only breakable flex item, so every pixel of overflow is charged to it: its width collapses to ≈0 and "DGX-1" lays out one glyph per line. The remaining row width then exceeds the container and trailing items paint outside the card.

**Blast radius.** Only the node page renders this many row items; DGX-1 already carries `HEAD · SPARK · ONLINE · host · Agent 0.5.0 · TELEMETRY GAP · …` plus 8 buttons, and TP-2 heads add health-finding chips.

**Decision.**
- Header action row becomes `class="row row--wrap"` (existing hook, `irori.css:100`) so chips/buttons flow to a second line.
- `.detail-title { flex: none; white-space: nowrap; }` on the `<h1>`, and `min-width: 0` on the `.pagehead` child so a long node name wraps at spaces instead of being squeezed.
- Leave ≤720px behaviour unchanged (it already wraps).

**Rejected.** Shrinking chips to fit (illegible mono caps); collapsing secondary chips into a “…” menu (hides at-a-glance state: role, online, agent version); horizontal scroll on the header (hides actions behind a scroll affordance nobody finds).

**Verification.** Reproduce with the DGX-1 chip set at 1440 / 1280 / 1080 / 820 px: title on one line, no element painting outside `.container`, no new vertical clipping.

---

## 2. GPU clock cap: free-text input → preset select

**Current.** `<input inputmode="numeric" placeholder="SM cap MHz">` (`NodeDetail.vue:1194-1201`), parsed/validated in `applyCap()` (`:256-269`), sent by `setClockCap()` (`apps/web/src/api.ts:191-200`) to `PUT /api/v1/nodes/:id/clock-cap` (`apps/server/src/app.ts:1305-1345`), which calls `hub.setClocks()` (`apps/server/src/hub.ts:555-566`) → agent `setSmCap()` → `nvidia-smi -lgc 0,N` / `-rgc` (`apps/agent/src/clocks.ts:66-75`), with the optional oneshot `irori-gpu-clock-cap.service` (`:81-135`). The stored cap is mirrored onto the node (`packages/db/src/schema.ts:56-59`, `packages/core/src/node.ts:36-39`, `store.setGpuClockCap`, `store.ts:156-160`) and the form re-seeds from it on node switch (`NodeDetail.vue:247-255`).

**Evidence for the preset range.** DGX-1 `nvidia-smi --query-gpu=clocks.max.sm` → **3003 MHz** (matches the card's `sm 214 / 3,003 MHz`), so 3000 is the top preset and `Clear` remains the true “driver default” action.

**Decision.** Replace the input with `<select class="select">` (the app's existing select convention, e.g. `NodeModal.vue:173`, `OverviewView.vue:476`):
- options `1800 / 2000 / 2200 / 3000 MHz` (owner's list), plus
- a **“current value”** option when the stored cap is not one of the presets (e.g. `2400 (current)`), so the control never misrepresents node state,
- `Apply` disabled while nothing is chosen; `Clear` unchanged.
`applyCap()` loses the parseInt path and takes the value from the select (still validating positive integer, still sending `null` for Clear).

**Rejected.** `<input list>` + `<datalist>` (still accepts arbitrary text — the owner's complaint); range slider (imprecise, no MHz reading).

**Verification.** Apply 2000 → `nvidia-smi -q -d CLOCK` shows applications SM = 2000 MHz and `node.gpuClockCapMHz` = 2000; Clear → `-rgc` and the field reads empty; a stored non-preset value shows as the current option.

---

## 3. CPU underclock (new capability — spec'd, not implemented)

**Spec already says how.** `docs/SPEC.md:360-368`: *“CPU: per-core `cpufreq` `scaling_max_freq` cap (kHz) — not `max_perf` on GB10 (accepted but re-derived); reset from `cpuinfo_max_freq`… Executed by the privileged agent directly… Desired state (gpu, cpu) stored server-side; re-applied on every node online transition.”*

**Implementation gap — nothing exists.** No CPU fields in the clocks wire messages (`packages/core/src/job-messages.ts:145-205` — `smMaxMHz` only), the agent clocks module is GPU-only (`apps/agent/src/clocks.ts`), no DB columns (`packages/db/src/schema.ts:56-59`), no REST field (`app.ts:1183-1345`), no UI. The `cpu 2,000 / 2,000 MHz` note on the node page is the collector's `scaling_cur_freq` / `scaling_max_freq` read (`apps/agent/src/collector.ts:536-556`, note shaping in `apps/web/src/detail-data.ts:112-120`).

**Live platform truth (DGX-1, GB10, kernel 7.0.0-1019-nvidia, Ubuntu 24.04.5, host booted 2026-09-23 12:20):**

| Property | Observed |
|---|---|
| Policies | 20, driver `cppc_cpufreq`, one policy per CPU |
| Cluster A (cpus 0-4, 10-14) | `cpuinfo_min_freq` 338,000 · `cpuinfo_max_freq` 2,808,000 kHz |
| Cluster B (cpus 5-9, 15-19) | `cpuinfo_min_freq` 1,378,000 · `cpuinfo_max_freq` 3,900,000 kHz |
| Current cap | `scaling_max_freq` = **2,000,000 on all 20 policies**; governor `performance`; `cpufreq/boost` = 0 |
| Writable surface | `scaling_max_freq` is `-rw-r--r-- root:root` → root only; the agent runs as root by design (`docs/SPEC.md:31`) |
| Step list | **No `scaling_available_frequencies`** — the driver accepts any value inside `[cpuinfo_min, cpuinfo_max]`, so the UI presets cannot be read from the node and must be our own list |
| External writer | `policy0/scaling_max_freq` mtime **2026-10-15 13:51** — i.e. *after* the last boot; `scaling_governor` mtime moves every ~2 min while `dgx-dashboard-admin.service` runs. The CPU cap is externally mutable state |
| No power-profile tool | `nvpmodel` absent; `energy_performance_preference_val` present (EPP is a hint, not a MHz ceiling) |

**Decision (design).**
1. **core** (`packages/core/src/job-messages.ts`): `clocksSetMsgSchema` gains optional `cpuMaxMHz: z.number().int().positive().nullable()`; `clocksGetResultMsgSchema` gains an optional `cpu` block `{ policies: [{ cpus: int[], minKHz, maxKHz, curMaxKHz }], capMHz }` (`.optional()`, so old agents still parse and old hubs ignore it).
2. **agent** (new `apps/agent/src/cpu-clocks.ts`, wired in `main.ts:349-370` + `transport.ts:489-492`):
   - read: enumerate `/sys/devices/system/cpu/cpufreq/policy*`, group identical `(cpus, cpuinfo_min, cpuinfo_max)` rows into clusters;
   - apply: for each policy write `min(capMHz×1000, cpuinfo_max_freq)` into `scaling_max_freq` — ceiling semantics, so a cap above a cluster's max leaves that cluster unchanged; report the effective per-cluster value back;
   - clear: write `cpuinfo_max_freq` back per policy (driver default);
   - persist: `irori-cpu-clock-cap.service` oneshot (same unit-marker + foreign-unit collision guard as `clockCapUnitBody`, `clocks.ts:86-135`) whose `ExecStart` runs a POSIX `sh -c` loop over `policy*/scaling_max_freq`, clamping per policy.
3. **DB** (`packages/db`): `nodes.cpu_clock_cap_mhz integer null` + `nodes.cpu_clock_cap_persistent boolean not null default false` (drizzle migration, mirrors `schema.ts:56-59`); `store.setCpuClockCap` (`store.ts:28,156-160`); node projection + `nodeInfoSchema` fields with `.default(null)/.default(false)` (`packages/core/src/node.ts:36-39`, `apps/server/src/app.ts:135`) so existing fixtures stay valid.
4. **server**: `hub.setClocks(nodeId, { smMaxMHz?, cpuMaxMHz? }, persist)` sends the caps in the `clocks-set` frame (either field may be absent); the routes apply **one frame per side** so a landed half is stored even when the other fails; `PUT /api/v1/nodes/:id/clock-cap` accepts `capMHz`/`cpuCapMHz` (absent = untouched, null = clear) bounded to the node schema's 300–4000 MHz, and `persistent` with a null cap removes the boot unit; the audit summary names both caps with the values present in the body; `GET /api/v1/nodes/:id/clocks` returns `{ gpus, cpu }` where `cpu` absent = old agent and `cpu: null` = no cpufreq on the platform. `POST /clocks` stays a one-shot apply (never touches persistence).
5. **web**: second select in the CPU card, presets **1400 / 2000 / 2800 MHz** (owner decision 2026-11-04: three options only; 2000 = today's state) + current-value option + Clear, plus `keep after reboot` sharing the existing pattern. A cap is a **uniform ceiling** on every policy (`min(cap, cpuinfo_max_freq)`), so each preset caps BOTH GB10 clusters — 2800 → 2,800 MHz on the 2,808 MHz cores *and* on the 3,900 MHz cores; only a cap above a cluster's own maximum would leave that cluster alone (none of the three does). When the node's agent predates the feature (no `cpu` block in the clocks reply) the row renders a muted note `agent too old for CPU caps — update the agent`; a `cpu: null` reply (no cpufreq on the platform) renders `no cpufreq on this node — CPU caps unavailable` instead of a dead control.

**Rejected.**
- `scaling_setspeed` + `userspace` governor: it sets an absolute operating point, not a ceiling, and moves the governor off `performance` (which the DGX stack keeps re-asserting) — fights the platform.
- `energy_performance_preference` only: a firmware hint, cannot express 1800/2000/2200/3000 and has no MHz read-back.
- `nvpmodel`/discrete power modes: tool absent on this image and it cannot express the owner's MHz steps.
- Hub-side re-apply on every online transition (SPEC's sentence): correct end state, but not required for this round (persistence covers reboots); track it as a follow-up because **the same sentence is unimplemented for the GPU cap today** — nothing re-applies `gpuClockCapMHz` on an online transition (`grep gpuClockCap` → only store/route/projection reads).

**Rollout constraint.** CPU control needs the new agent on every node; `agent-update` restarts the agent and kills supervised serving (IR-176 incident lesson). Schedule a maintenance window per node; the hub and UI must stay correct against old agents (they will: the `cpu` block is optional and the UI degrades to the note above).

**Verification.** `PUT` `{cpuCapMHz: 2000, persistent: true}` → agent writes 2,000,000 to all 20 policies (`scaling_max_freq` read-back), unit enabled; `Clear` → 2,808,000 / 3,900,000 per cluster; reboot once → cap re-applied; old agent → 200 with no `cpu` block, UI shows the degrade note.

---

## 4. Temperature overlay on the CPU / GPU history charts

**Current.** History buckets already carry per-point temperature bands: `cpuTemp`/`gpuTemp` `{min, avg, max}` (`apps/web/src/api.ts:416-431`; server shaping `apps/server/src/history.ts:44-48,85-88,136-139`; source columns `packages/db/src/schema.ts:110-119`). The cards print only the band under the line (`detail-data.ts:120-126` CPU sub, `:148-158` GPU sub) and the sparkline plots utilization alone with a `{min:0,max:100}` domain (`NodeDetail.vue:1161` CPU, `:1191` GPU). `Sparkline` is single-series with a one-line tooltip (`apps/web/src/components/Sparkline.vue:6-22` props, `:44-99` render/hover).

**Decision.** Extend `Sparkline` with an optional second series — `points2`, `color2`, `label`/`label2`, `format2`, `domain2` — drawn dashed on its own scale through the existing `sparklinePath(points, w, h, domain, fixed)` overload (`apps/web/src/sparkline.ts:39-52`), with a two-row tooltip using the already-styled `.charttip__row / __swatch / __label / __value` (`irori.css:284-296`). `computeDetailData` gains `seriesTemp` for the CPU and GPU panels (`points.map(p => p.cpuTemp.avg)` / `p.gpuTemp.avg`), and each card gets a one-line legend (`usage — 45% · temp - - 47 °C`) so the second line is not a mystery. Usage keeps `var(--ink-2)`; temperature uses `var(--thread)`, the accent already used by the temps lens palette (`apps/web/src/analytics.ts:66-70`).

**Rejected.** Reusing `LensChart` (multi-series, per-series scale, hover rows — but it also brings guides/markers/times bookkeeping for a two-line card; `LensChart.vue:60-150`, `analytics.ts:98-140`). Keep it as the fallback if we later want the analytics look on the node page.

**Note.** The overlay plots the bucket **average**; max spikes stay visible in the sub line, which is the honest split for a 1px line.

---

## 5. Network card: interface rows paint outside the card

**Current.** `.barrow` is `display:grid; grid-template-columns: 64px 1fr auto` (`irori.css:217`) and `.barrow .val { white-space: nowrap; text-align: right }` (`irori.css:219`) — the `auto` column grows past the card and paints over the neighbouring grid column (screenshot: `enP7s7` with five IPv6 addresses). Rows render `linkLabel(speedMbps) · operState · addrs.join(", ")` for every snapshot interface (`NodeDetail.vue:1307-1312` over `snapshot.network`, `:307`). `.cols > * { min-width: 0 }` (`irori.css:93`) only prevents page-level overflow, not paint-outside.

**Decision.** Give the interface rows a wrap-capable variant: `.barrow--net` with `grid-template-columns: 64px 1fr` and the value spanning both lines (`white-space: normal; overflow-wrap: anywhere; text-align: right`), so addresses wrap **inside** the card; iface + speed/state stay on the first line and the address list follows beneath. The full list stays in `title` for copy targets.

**Rejected.** Ellipsis truncation (the addresses are the point of the card); per-row horizontal scroll (nested scrollbars in a 2-col grid).

---

## Delivery plan

**Epic:** UI feedback round 6 — node header wrap, clock-cap selects, CPU underclock, chart temperature overlay, network rows.

| # | Story (Task) | Area | Depends on | Acceptance criteria |
|---|---|---|---|---|
| S1 | Node page header wraps; title never collapses | web CSS/template | — | With the full DGX-1 chip set at 1440/1280/1080/820 px the h1 renders on one line; chips/buttons wrap to a second row; nothing paints outside `.container`; ≤720 px unchanged |
| S2 | GPU clock cap is a preset select (1800/2000/2200/3000 + current + Clear) | web | — | Selecting a preset and Apply sets `clocks.applications.sm` to that value and persists the registry field; a non-preset stored cap appears as the current option; Clear resets to driver default |
| S3 | CPU and GPU history charts overlay temperature | web | — | Both cards draw a dashed temp line on its own scale; hover tooltip shows usage % and °C rows; legend states which line is which; null buckets render gaps (no fabricated zeros) |
| S4 | Network interface rows stay inside the card | web CSS/template | — | An interface with 5 IPv6 addresses wraps within the card at 1440 and 1080 px; no horizontal paint-past; full list still available |
| S5 | CPU underclock backend: core messages, agent read/apply/persist, DB columns, REST | core/agent/db/server | — | `PUT /clock-cap` with `cpuCapMHz` writes `min(cap, cluster max)` per policy and reports effective values; clear restores `cpuinfo_max_freq`; oneshot re-applies after reboot; `GET /clocks` returns the `cpu` block; old agents degrade cleanly; DB migration + audit entry |
| S6 | CPU cap select in the node page (presets 1400/2000/2800 + degrade note) | web | S5 | CPU card select applies/clears the cap end to end through the UI; shows the effective per-cluster MHz read-back; an old agent shows the “update the agent” note and no dead control |

Order: **S1 → S4 → S2 → S3** (frontend batch, can land in one or two PRs), then **S5 → S6**. S5 needs a per-node agent rollout window (agent restart kills supervised serving).

Priority: Medium for all six (repo convention); no story points fabricated.

## Risks & open questions

1. **CPU preset list — RESOLVED (owner, 2026-11-04): 1400 / 2000 / 2800 MHz, three options only.** The owner's 1800/2000/2200/3000 remain GPU-only values. GB10's clusters top out at 2,808 MHz and 3,900 MHz, and a cap is a uniform ceiling, so **all three presets cap both clusters** (2800 → 2,800 MHz everywhere; the performance cores lose 28%). That is the accepted behavior — a single `scaling_max_freq` ceiling cannot express "cap cluster A only"; per-cluster caps would be a separate design change.
2. **Something else owns the CPU cap.** `scaling_max_freq` was re-written after boot (mtime 2026-10-15 while the host booted 2026-09-23) and the governor is re-written every ~2 min by `dgx-dashboard-admin.service`. Our cap can be silently reverted mid-run. Mitigation to decide in S5: re-assert on agent start + on hub “node online”, and/or a health rule when the observed cap ≠ the stored cap. `After=multi-user.target` in the oneshot may also run *before* the DGX writer at boot — verify across one reboot.
3. **Agent rollout cost.** S5/S6 only work on nodes running the new agent; the fleet restart kills running setups. Plan the window; keep the old-agent degrade path tested.
4. **SPEC drift.** `docs/SPEC.md:360-368` claims fleet-wide apply and re-apply on every node online transition; neither exists for GPUs today. Decide whether this round narrows the claim (documented limitation) or adds the re-apply path (new scope).
5. **Markup tests.** No existing test pins the header or network rows; new regression coverage should assert structure/classes (as `ds-markup.test.ts` does) rather than pixel geometry. Fixtures carrying `gpuClockCap*` (`apps/web/test/card-data.test.ts:23-24`, `live.test.ts:22-23`, `node-form.test.ts:28-29`, `serve.test.ts:84-85`, `llm-data.test.ts:55-56`) gain the new defaulted CPU fields; adding `.default()` keeps them valid.

## Jira overlap findings (project IR, 2026-11-04)

| Key | Type / status | Relation |
|---|---|---|
| IR-159 | Story / Done — "IRI-068 Power and clock controls: node shutdown, wake-on-LAN, GPU clock cap" | Prior art for the GPU cap; this round changes only the input control, no new endpoint |
| IR-158 | Story / Done — "IRI-067 Telemetry parity … clock endpoints" | Prior art for `GET/POST /clocks`; CPU fields extend it |
| IR-176 | Epic / To Do — hub oversized-frame resilience | Unrelated (closed-out work) |
| IR-51 | Epic / To Do — usage telemetry phase 2 | Unrelated |

No open ticket covers a header layout defect, a clock-cap input redesign, CPU underclocking, temperature overlays on the history cards, or the network-row overflow — no duplicates, nothing to reuse as a child.
