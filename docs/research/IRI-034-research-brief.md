# IRI-034 research brief — Node page UX: ghost probe port, store catalog on spark nodes, CPU clock

- **Date:** 2026-10-27
- **Ticket:** IRI-034
- **Goal:** three owner-reported node-page issues: (1) a probe port deleted from the node (8080) keeps rendering in the Inference card, (2) the NAS store catalog renders on DGX-1's node page, (3) the History CPU card should show the current clock speed like the GPU card does.

## 1. Deleted probe port 8080 still renders in the Inference card

### Evidence

Edit path (the modal is truthful — the DB is correct):

- `apps/web/src/components/NodeModal.vue:184` — "LLM probe ports (comma-separated)" input; submit calls `patchNode` (`:97`) → `PATCH /api/v1/nodes/:id` (`apps/web/src/api.ts:119-130`).
- `apps/web/src/node-form.ts:71-80` — `toPatchPayload` sends `llmPorts: parsePorts(...)`; `formFromNode` (`:24-33`) fills the modal from `node.llmPorts`. The modal showing only `8081` proves `nodes.llmPorts = [8081]` in the DB.
- `apps/server/src/app.ts:344-361` — the PATCH handler zod-validates and calls `store.patch(id, patch)`; nothing else. `packages/db/src/store.ts:86-98` updates only the `nodes` row — **no ring clear, no llm_snapshots delete, no push to the agent**.
- Stale comment: `app.ts:711-713` claims "nodePatchSchema (core, out of M3 scope) has no llmPorts yet" — false; `packages/core/src/node.ts:46-48` includes `llmPorts`.

How the ghost is re-created continuously:

- The agent learns probe ports **only** via `config-update`: built from the DB row at `apps/server/src/hub.ts:126-137`, sent on hello (`hub.ts:258`) or via `hub.refreshConfig(nodeId)` (`hub.ts:410-415`). Its **only caller is the setups service** (`apps/server/src/setups-service.ts:337`, wired `apps/server/src/index.ts:256`) — the PATCH/PUT routes never push.
- `apps/agent/src/transport.ts:451-483` applies the port set; `apps/agent/src/main.ts:47-57` `ensureProbes` **does** delete removed probes — but only when a config-update arrives. `apps/agent/src/llm-probe.ts:497` reports `{ backend: "unknown", detected: false }` for silent ports every tick (`LLM_PROBE_CADENCE_MS = 2000`, `hub.ts:49`); each frame re-enters ring + SSE + `llm_snapshots` (`hub.ts:282-292`).

Why the UI shows it:

- `apps/web/src/components/NodeDetail.vue:146-152` — the merge renders **every reported port**, no `detected` filter:
  ```ts
  // Displayed ports: configured list first, then any hot-added probe ports.
  const ports: number[] = [];
  for (const p of [...configured, ...(entry?.ports ?? []).map((s) => s.port)]) {
    if (!ports.includes(p)) ports.push(p);
  }
  ```
- `apps/web/src/llm-data.ts:160-183` — `shapeLlmPort` maps a missing/undetected snapshot to `backendLabel("unknown")` + `stateLabel: "idle"` (the `UNKNOWN IDLE` chips); `apps/web/src/components/LlmPanel.vue:67-70` renders `no engine answered` / `Probes continue on idle ports` for `!detected`.
- Overview is stricter — `apps/web/src/components/OverviewView.vue:105-109`: `if (covered.has(key) || p.detected !== true) continue;` — only **detected** hot-added ports surface there. NodeDetail never adopted that rule.

Persistence (secondary):

- `packages/db/src/schema.ts:124-153` — `llm_snapshots` (raw jsonb per pass) and `llm_buckets` per `(node_id, port, granularity)`; pruned by time only (`apps/server/src/retention.ts:69-78`). Nothing prunes per-port rows on port removal.
- `GET /api/v1/nodes/:id/llm` (`app.ts:678-692`) serves the in-memory ring or the **latest persisted row** (`apps/server/src/llm-store.ts:55-63`) with no filtering against `nodes.llmPorts` — if the agent is offline, the REST seed shows the ghost indefinitely.

Live check (dgx1, 2026-10-27): `/etc/systemd/system/irori-agent.service` has `EnvironmentFile=-/etc/irori/agent.env`; no `IRORI_LLM_TARGETS` found in the unit or override dirs. The env file itself is root-only (`grep: Permission denied` as operator). Since 8080 was editable in the UI modal, it lived in `nodes.llmPorts`, not in an env override — and the render rule below covers a residual env target anyway (env-added idle ports are undetected and unconfigured → hidden).

### Root cause (ranked)

1. **Saving ports never reaches the connected agent** — no `config-update` on `PATCH /nodes/:id` or `PUT /nodes/:id/llm-ports` (`app.ts:711-724`). The agent keeps probing 8080 every 2 s and each frame re-inserts the ghost. Self-heals only on the next WS reconnect (hello → fresh config).
2. **The web merge renders every reported port** (`NodeDetail.vue:147-152`) — deliberately for hot-added probes; with (1) it faithfully shows the ghost.
3. **No per-port pruning** — matters only in the agent-offline window (REST fallback).

### Options

| Option | Change | Fixes | Cost / risk |
|---|---|---|---|
| **A. Push config-update on save** | In PATCH (when `llmPorts` among sent keys) and in `PUT /nodes/:id/llm-ports`, call a new `AppDeps.refreshNodeConfig(id)` → `hub.refreshConfig(id)` (closure dep pattern like setups, `index.ts:256`) | Source of truth: agent's `ensureProbes` deletes the 8080 probe; next 2 s frame has only 8081; ring/SSE/DB self-heal | Small server change; hub built after `createApp` → late-bound dep; offline agent covered by hello on reconnect |
| **B. Render configured ∪ detected** | `NodeDetail.vue:147-152` and `llmSummaryLine` (`llm-data.ts:189-201`): skip snapshot ports where `!configured.includes(port) && snap?.detected !== true` | Symptom, incl. agent-offline window and `IRORI_LLM_TARGETS` residuals; Overview parity | Test contract `apps/web/src/llm-data.test.ts:237-244` pins hot-add append — must be updated to the new rule |
| C. TTL / prune per-port state | Drop or flag ring & fallback entries older than N s | Nothing alone — the data is *fresh* (agent live-probing); only helps offline windows | Extra machinery for no primary benefit |

### Decision

**A + B.** A fixes the source; B is defense-in-depth and fixes the offline window. Consequence: `llm_snapshots`/`llm_buckets` rows for 8080 remain until time retention (history keeps the old series — accepted). The `ds-markup.test.ts:104-107` strings (`no engine answered` / `Probes continue on idle ports`) stay — configured idle ports (e.g. 8081 on DGX-1) must keep rendering them.

## 2. NAS store catalog on the DGX-1 node page

### Evidence

- Agent side (the actual gate) — `apps/agent/src/inventory.ts:344-346`:
  ```ts
  let store: NodeInventory["store"] = null;
  if (ctx.nasRoot !== null) {
    const read = await readStore(ctx.nasRoot);
  ```
  Any node with `nasRoot` set gets the **entire** store catalog (catalog.json schema 3, or an `active/` scan) plus `readFailedDeletes` leftovers in its `models-inventory` report.
- `nasRoot` is a capability flag, not "is the store node": `packages/core/src/node.ts:30-31` — "NAS store root for model-ops nodes, e.g. /mnt/nas (M4); null otherwise". DGX-1 (`kind: spark`, `role: head`) mounts the store via CIFS, so it qualifies. The schema comment at `packages/core/src/inventory.ts:36` ("present only when the node has a modelctl store root") reads as intended, but the render result is the full catalog.
- The agent **cannot** gate on kind: `config-update` carries no `kind` (`packages/core/src/agent-messages.ts:53-74`).
- Hub caches the report per node (`apps/server/src/jobs-service.ts:49-70` `settleInventory` → `node_inventory`) and serves it unfiltered: `GET /api/v1/nodes/:id/models` (`app.ts:644-656` → `inventory-service.ts:23-31`).
- Web render gate — `apps/web/src/components/NodeDetail.vue:592`: `<article v-if="inventory.store" class="card">` — full catalog table with Delete rows (`:637`) and failed-delete leftover banners (`:607-626`). `storeRows` at `:193`; `storeMount` falls back to `node.value?.nasRoot` (`:195`).
- `NODE_KINDS = ["spark", "gpu-host", "nas"]` (`packages/core/src/node.ts:3`). The only `kind === "nas"` special-casing is store placement (`pickStoreNode`) — display-unrelated.
- The global Models page is a separate surface (`model_meta` deduped union; `ModelsView.vue:74` → `GET /api/v1/models`).

### Options

| Option | Change | Tradeoff |
|---|---|---|
| **A. Render gate on the store card** | `v-if="inventory.store && node?.kind === 'nas'"` in `NodeDetail.vue:592` — web-only, one condition | Catalog/leftovers/delete rows appear only on the NAS node page; mounting nodes lose the "store mounted here" hint |
| B. Compact summary on mounting nodes | Keep a one-line "Store · /mnt/nas · N models → Models page" instead of the table on non-nas kinds | Preserves the mount signal, but keeps a surface the owner called unnecessary |
| C. Suppress store server/agent-side | Plumb `kind` into `config-update` or drop `store` at settle for non-nas kinds | Throws away data; more moving parts; agent change rides fleet rollout for nothing |

### Decision

**A.** The owner's words: "there is no reason for that". The catalog (and the leftover banners / delete rows inside the card) belong to the store node — the NAS node page — and the global Models page. `Disk hygiene` and the local cache cards are unaffected. If a mount hint is ever wanted, option B is a follow-up.

## 3. CPU current clock in the History card (like the GPU `sm` line)

### Evidence

- GPU note comes from the **live snapshot**, not history — `apps/web/src/detail-data.ts:146-158`:
  ```ts
  const gpu = snapshot?.gpus[0];
  if (gpu?.smClockMHz != null) {
    const max = gpu.smClockMaxMHz != null ? ` / ${gpu.smClockMaxMHz.toLocaleString("en-US")}` : "";
    gpuNotes.push(`sm ${gpu.smClockMHz.toLocaleString("en-US")}${max} MHz`);
  }
  ```
  Rendered by a notes loop at `NodeDetail.vue:776`. The CPU card has `notes: []` (`detail-data.ts:118-125`) and its template renders only `sub` (`NodeDetail.vue:750-754`) — **no notes loop** (Memory `:764-765` and GPU `:776` have one).
- **The current CPU clock is already captured end-to-end**: `apps/agent/src/collector.ts:515-536` `readPerCoreClocksKHz` reads `/sys/devices/system/cpu/cpuN/cpufreq/scaling_cur_freq` per core; payload `cpu.perCoreClocksKHz` (`collector.ts:99-103, 124-125`); schema `packages/core/src/snapshot.ts:48-49` (`perCoreClocksKHz: z.array(z.number().nonnegative()).optional()`, "Per-core current frequency in kHz, /sys cpufreq order"); it persists in `snapshots.payload` jsonb (`packages/db/src/schema.ts:67-78`) and reaches the web live snapshot (`NodeDetail.vue:43` `snapshot = live.snapshots.get(nodeId)`).
- **No max clock is captured anywhere** (only `scaling_cur_freq`), and history does not aggregate clocks: `snapshot_buckets` has no clock columns (`packages/db/src/schema.ts:93-122`), `rollups.ts:139-143` extracts only usage/temp/power, `HistoryPoint` has no clock fields (`apps/server/src/history.ts:27-40`).
- Live GB10 evidence (dgx1, 2026-10-27, command transcript):
  - 20 cores aarch64; `/proc/cpuinfo` has **no "MHz" lines** (ARM) → cpufreq sysfs is the only source.
  - `/sys/devices/system/cpu/cpufreq/policy0..19` exist (one policy per core); `scaling_cur_freq` = `2000000` on all 20 (governor `performance`); `scaling_min_freq` differs by cluster (338 MHz ×15, 1378 MHz ×5); `cpuinfo_cur_freq` empty; `cpuinfo_avg_freq` (cpu0) = `1900335`.
  - `nvidia-smi --query-gpu=...` → `NVIDIA GB10, 2190 MHz, 3003 MHz, 64, 30.15 W` — exactly the UI's `sm 2,190 / 3,003 MHz`.
  - No tegrastats; `sensors` exposes acpitz/NIC/NVMe zones only (no coretemp-style CPU package sensor) — the existing CPU temp capture (`readCpuTempC`, hwmon `cpu|package|soc|coretemp` regex, `collector.ts:419-456`) is the right channel and already works.

### Options

| Option | Change | Result |
|---|---|---|
| **A. Web-only current clock** | In the `hasHistory` block, `snapshot?.cpu?.perCoreClocksKHz` → `Math.max(...)` → CPU note `cpu 2,000 MHz`; add the notes loop to the CPU card template | Ships with the web build; zero agent/schema change |
| **B. Exact mirror** | Also capture `perCoreMaxClocksKHz` (`scaling_max_freq` in the same `collector.ts` loop) + optional field in `snapshot.ts` → note `cpu 2,000 / 2,000 MHz` | Mirrors `sm 2,190 / 3,003 MHz` exactly; rides the next agent bundle (fleet agents are already pending an update) |
| C. Range-aggregated clock history | `snapshot_buckets.cpu_clock_*` + rollups + `HistoryPoint` | Rejected: the GPU `sm` note is live-only — no per-bucket GPU clock exists either; this would be new product surface, not parity |

### Decision

**A + B.** A lands with the web change (`cpu 2,000 MHz`); B completes the `cpu X / Y MHz` mirror when the next agent bundle rolls out (the field is optional — the note degrades gracefully). Aggregation: **max across cores** (all equal under the `performance` governor; under `schedutil` the max reflects the active boost clock). Alternative noted: `cpuinfo_avg_freq` reports a measured 1.90 GHz on dgx1, but it is per-cpu, not captured today, and switching sources adds churn for no gain.

## Summary of Findings

1. **Ghost port 8080**: root cause is that saving probe ports never pushes a `config-update` — the agent re-probes 8080 every 2 s and each frame re-inserts it; the web merge renders every reported port. Fix: push config-update on `PATCH /nodes/:id` (llmPorts) and `PUT /nodes/:id/llm-ports` via a new `AppDeps.refreshNodeConfig` (setups pattern), plus render configured ∪ detected in `NodeDetail.vue` and `llmSummaryLine` (Overview parity). Rows for removed ports persist until time retention — accepted.
2. **Store catalog on node pages**: the agent attaches the full store catalog to the inventory report of *any* node with `nasRoot` set (DGX-1 mounts the store), and the web renders it whenever the report has one. Fix: render the Store card only when `node.kind === "nas"` — web-only one-liner; leftover banners and delete rows move to the NAS node page with it. No agent/server change.
3. **CPU clock**: `cpu.perCoreClocksKHz` already flows to the web live snapshot but is rendered nowhere. Fix: CPU notes loop + `cpu 2,000 MHz` note (web-only), and `perCoreMaxClocksKHz` capture in the agent for the ` / 2,000` suffix (next bundle). No DB, rollup, or history-endpoint change.

Open: none blocking. Residual unknown — the contents of `/etc/irori/agent.env` on dgx1 are root-only; a hypothetical `IRORI_LLM_TARGETS=…8080` residual would keep the agent probing, but the new render rule hides an idle unconfigured port regardless, and 8080 was UI-editable (so it lived in `nodes.llmPorts`).
