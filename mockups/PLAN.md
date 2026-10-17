# Mockup iteration plan — round 2: Models in-depth review · Serve for homelab scale

Status: **executed 2026-10-17** — models v2, serve v2, `setup-wizard.html`
shipped; SPEC §6/§7/§13 + PLAN M4/M5 amended. Original plan below.
Inputs: owner direction (this file's triggers), round-1 reviews (UX + PM,
applied in `a9efbf0`), SPEC §6/§7/§13.

---

## Part 1 — Models page: full reconsideration

### Trigger (owner)

No search, no pagination, no ordering (incl. by date added), "Repository @ rev"
column not needed, download queue should be a modal, screen is noisy. Full
review and reconsideration required.

### Method

Senior-UI/UX expert pass over `models.html` (current + v2) with the round-1
rubric plus a JTBD/IA layer, then a v2 mockup. The expert reviews **source +
rendered light/dark screenshots** and returns ranked findings; findings are
applied before the round is presented.

### Jobs the screen must serve (in priority order)

1. Find a model and see where it lives (per node) — the 90 % case.
2. Get a model onto a node (sync/push/download) — one click from the row.
3. Add/remove models on the NAS (modal, armed).
4. Trust the store (capacity, catalog freshness, modelctl/doctor) — glanceable.
5. Create a recipe from a model (serve-command copy, HF metadata).

### Proposed IA (v2) — one table, everything else on demand

- **Toolbar**: search (matches name, repo, quantization — debounced, ⌘K
  focusable) · filter chips (runtime: vllm/llama.cpp; placement: on head / on
  any node / not synced) · sort dropdown (**Recently added** default, Name,
  Size) · result count · `Download from HF…` (primary) · overflow menu
  (Refresh catalog, Store hygiene…).
- **Table** (the only always-visible block): Name (bold) with repo ·
  quantization · companions as the **secondary line** (replaces the
  "Repository @ rev" column); Runtime · Size · Added · Placement (compact
  chips: `head ✓` `spark2 sync` `spark3 push`) · row actions (`Serve`,
  `⋯` → Open details / Sync / Push / Copy serve-command / Delete…).
  - **Pagination**: 25/page with count + pager (homelab stores are tens, not
    thousands; search+filters keep pages short). No infinite scroll.
  - **Row click → detail drawer** (right side, not a new page): HF card
    metadata, revision, file list + sizes, companions (mmproj/MTP), per-node
    placement with one-click remediations, `serve-command` copy, README/RUN.md
    excerpt, delete (dry-run plan → armed confirm typing the model name).
- **Download modal** (replaces the inline queue section): multi-row form
  (source, local name, runtime, quantization, companions), preflight summary
  (total size, capacity check vs free − reserve), `Queue download` → closes
  into the Jobs strip.
- **Status strip** (slim, one line): capacity bar · catalog seq + freshness ·
  modelctl version · jobs summary — with a `Store health` popover holding
  staging/objects/quarantine + doctor / gc-objects (dry-run → armed). Removes
  the whole hygiene card from the canvas.
- **Jobs strip stays** (it is the transfer surface) but collapses to one row
  when idle; full table behind `Jobs (n)`.

### Data-model note (blocking detail for "date added")

`modelctl catalog.json` (schema 3) carries name/runtime/repository/bytes —
**no timestamp**. Ordering by date added therefore needs Irori-side state:
`models(nas_node_id, name, first_seen_at, …)` recorded when the catalog reader
first observes a model. Cheap, no NAS writes, survives modelctl upgrades.
Flagged to `packages/core` + `packages/db` for M4.

### Deliverables & acceptance

- `mockups/models.html` **v2** (toolbar/search/filters/sort/pagination,
  secondary-line rows, drawer open state, download modal open state, hygiene
  popover) + an **empty-search** and **zero-models** state.
- Expert findings list (ranked) applied; light/dark screenshot verification;
  zero console errors; single filled button per state; no thread fills.
- SPEC §6 amended: search/sort/pagination contract, drawer, `first_seen_at`.

---

## Part 2 — Serve page: homelab scale (1–8 Sparks, most have 2) + setup wizard

### Trigger (owner)

Replace "Register recipe" / "Run script" with **one modal wizard**:
setup type → model → existence check on sparks → start/stop script paths
(validated on the head node) → model-missing placement offer (pull from NAS,
sync to worker) → staged progress with %, rate, ETA. Think it through and name
what's missing.

### Scale analysis

- ≤ 8 nodes ⇒ deployments never need an enterprise table with drift chips,
  probe-join jargon, or per-row endpoint walls. **Setup cards** (one card per
  serving setup) scale to single digits and carry per-node state naturally.
- Most fleets: 1 head + 1 worker ⇒ the wizard must make the 2-node case the
  fastest path (worker fields appear only when "Cluster" is chosen).
- Card-per-setup replaces the deployments table; cluster-level jargon
  (`server probe join · 5s poll`) moves into card sublines.

### Wizard flow (owner's steps + additions marked ★)

1. **Type**: Single node | Cluster (head + workers). ★ Cluster asks which
   worker(s) — up to 8 total; per-role scripts in step 4.
2. **Model**: pick from NAS catalog (searchable, shows size/quant) or
   "download from HF first" (chains the Part-1 modal). ★ Also: which node
   role serves it (head-only vs head+worker sharded).
3. **Existence check**: per selected node → present / sync / push /
   unavailable (reuse placement planner + capacity math `free − needs −
   reserve`).
4. **Scripts**: start + stop **paths on the head node**, validated via agent
   (`test -x`) at wizard time *and re-checked at every start* (scripts move).
   ★ Missing pieces the owner didn't mention:
   - **Port** (default 8000, conflict-checked on the node) — needed for
     health probe, endpoints, per-port analytics.
   - **Worker scripts** for clusters (worker start/stop or join command),
     validated on each worker node.
   - **Env contract**: Irori exports `MODEL_NAME`, `PORT`, `EXTRA_ARGS` (and
     `MODEL_PATH` via `modelctl path --local`); wizard shows exactly what will
     be exported so self-contained scripts still work.
   - **Health definition**: state = port answers `/v1/models` with the model
     id; ask expected model id only if it differs; startup **timeout** with
     "starting → healthy / failed" and engine-log tail visible during the wait
     (big models take minutes).
   - **Log source**: optional log command / file path; default = engine port
     probe + process stdout ring captured by the agent.
5. **Placement** (if model missing anywhere): plan shows the **full chain** —
   NAS→head (`sync-local`), head→worker (`push`, CX7), or HF→NAS download
   first if the NAS lacks it — ★ staged progress (per stage: %, MB/s, ETA,
   cancel), not one flat bar; ★ warns if a node already has an active job;
   capacity check inline; "force from HF" stays a ghost option.
6. **Review & launch**: summary (type, model, nodes, scripts, port, env) →
   `Create & start` (primary) or `Create only`. Setup appears as a card;
   stop stays armed (typed confirmation), restart re-runs stop→start.

### Still missing from the owner's list (product decisions to confirm)

- Edit vs duplicate an existing setup (common: same shape, new model).
- What "stop" runs when the operator never gave a stop script — wizard should
  *require* stop (armed stop is a core promise) or fall back to killing the
  recorded pidfile/process group.
- Naming: auto `model-name` (editable) — no gateway, but logs/jobs reference it.
- Setup detail: drawer with engine log tail, per-node placement history,
  edit/duplicate/delete — confirm drawer vs expandable card.
- Script *changes on disk* (user edits start.sh): no git-drift tracking in v1
  (dropped with the recipe table) — re-validation at start covers existence,
  not content; document that.

### New Serve page IA (v2)

- Header: `New setup…` (primary, opens wizard) · summary chips (`2 running ·
  1 idle`) · `Jobs (n)` opener.
- **Setup cards**: model + quant, node chips with per-node state dots
  (■ present+healthy · ○ starting/transfer · ◆ stopped/foreign · halt square
  = stopped), port, last log line (1 line, mono), actions: `Logs` `Restart`
  `Stop…` `⋯` (Edit/Duplicate/Remove). Running transfers render an inline
  staged-progress strip on the card.
- Card click → detail drawer: full engine log tail (streamed), endpoints
  (direct), placement per node, scripts with last-validated timestamp,
  env contract, run history.

### SPEC / task impacts

- SPEC §7 rewrite: "recipes with dispatch verbs + git drift" → "setups =
  model + nodes + validated script pair + port + env contract"; §13 API
  (`/api/v1/setups` CRUD + `POST /:id/start|stop`); §5 data model `Setup`.
- PLAN: M5 acceptance rewritten around the wizard; M4 gains
  `first_seen_at` note.

### Deliverables & acceptance

- `mockups/serve.html` **v2** (setup cards, one running transfer inline,
  detail drawer) + **`setup-wizard.html`** (5 steps, cluster variant, staged
  progress state, failure state).
- Expert findings applied; light/dark verification; wizard reachable from
  both serve and models (download modal shared).

---

## Execution order

1. Part-1 expert review of current models.html → findings.
2. Models v2 (+ drawer/modal/popover states) → verify light/dark.
3. Part-2 scale pass on serve.html → v2 + wizard → verify.
4. SPEC §6/§7/§13 amendments + IRI-001 evidence update → commit.
