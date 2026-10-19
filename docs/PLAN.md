# Implementation plan — Irori epic

The epic is **IRI-EPIC-001: Irori v1 — DGX Spark inference fleet platform**,
sliced into vertically deliverable milestones: each ships something usable.
Effort is indicative (single developer with LLM assistance). Task files live in
`tasks/IRI-*.md` (convention: `IRI-NNN-short-title.md`, template
`tasks/task-template.md`); research briefs in `docs/research/`.

| M | Task | Theme | Exit |
|---|------|-------|------|
| M0 | [IRI-001](../tasks/IRI-001-m0-governance.md) | Governance, spec, ADRs, process, branding | Docs agreed · ADRs accepted · validate green |
| M1 | [IRI-002](../tasks/IRI-002-m1-walking-skeleton.md) | Workspace + server/web/agent skeleton + DS shell | Agent on one machine → live card in UI |
| M2 | [IRI-003](../tasks/IRI-003-m2-telemetry-core.md) | Telemetry first-class: collectors, rings, rollups, SSE | Two nodes streaming; history survives restart |
| M3 | [IRI-004](../tasks/IRI-004-m3-inference-monitoring.md) | LLM probes + cluster view | Head card: model, decode/prefill, queue |
| M4 | [IRI-005](../tasks/IRI-005-m4-model-supply-chain.md) | NAS + modelctl integration | NAS→head→worker transfer from UI |
| M5 | [IRI-006](../tasks/IRI-006-m5-serving-orchestration.md) | Setup wizard, script pairs, staged transfers | Serve cluster via wizard; logs in telemetry |
| M6 | [IRI-007](../tasks/IRI-007-m6-benchmarks.md) | Decode/prefill/quality/tooleval | Four benches run + persist against live engine |
| M7 | [IRI-008](../tasks/IRI-008-m7-analytics-packaging.md) | Analytics lenses, disk hygiene, multi-arch release | Analytics views; cleanup verified; arm64 agent deployed |
| M8 | [IRI-009](../tasks/IRI-009-m8-usage-capture-telemetry.md) | LLM usage capture proxy + telemetry (in-agent, 90 d retention) | Usage pages populated from live proxy traffic; replay + retention verified |

Tracking lives on Jira (project [IR — Irori](https://blastersystems.atlassian.net/browse/IR)):
each milestone is an epic sliced into deliverable-sized tickets. The CI/CD
epic deploys the server container to the Proxmox docker VM following
uptime-monitoring's `cd-dev.yml` pattern (`dev-*` tag → test gate → git-bundle
deploy → 60×2s health gate → auto-rollback).

| Milestone | Epic |
|---|---|
| M1 Walking skeleton | [IR-1](https://blastersystems.atlassian.net/browse/IR-1) |
| CI/CD — GitHub Actions → Proxmox docker VM | [IR-10](https://blastersystems.atlassian.net/browse/IR-10) |
| M2 Telemetry core | [IR-14](https://blastersystems.atlassian.net/browse/IR-14) |
| M3 Inference monitoring | [IR-21](https://blastersystems.atlassian.net/browse/IR-21) |
| M4 Model supply chain | [IR-24](https://blastersystems.atlassian.net/browse/IR-24) |
| M5 Serving orchestration | [IR-29](https://blastersystems.atlassian.net/browse/IR-29) |
| M6 Benchmarks | [IR-33](https://blastersystems.atlassian.net/browse/IR-33) |
| M7 Analytics, hygiene & packaging | [IR-37](https://blastersystems.atlassian.net/browse/IR-37) |
| M8 LLM usage capture & telemetry | [IR-42](https://blastersystems.atlassian.net/browse/IR-42) |
| Usage phase 2 — attribution & reconstruction (deferred) | [IR-51](https://blastersystems.atlassian.net/browse/IR-51) |

## M0 — Governance & foundations ✅ (this task)

- agentic-bootstrap scaffold (`--platform all`) — done 2026-10-16, validate green.
- SPEC.md (narrowed from the four source projects), this plan, ADR-0001…0006,
  development process + `implement`/`research` skills adapted from
  matterhorn-platform, README.
- **Exit**: docs reviewed; ADRs accepted; `.agentic/bin/validate` + docs-check green.

## M1 — Walking skeleton ✅ (f4a785f; agent live on dgx1)

- pnpm workspace (TS strict, vitest, eslint+prettier): `apps/server`
  (Express 5, `/healthz`, `/api/v1/nodes` CRUD, PostgreSQL on the Proxmox
  pgsql server via Drizzle — `DATABASE_URL`, migrations on boot),
  `apps/web` (Vue 3 + Vite, BlasterSystems DS token port + fonts + brand
  lockup + theme machinery, empty Overview), `apps/agent` (outbound WS hello +
  token auth + one hardware snapshot), `packages/core` (snapshot contract),
  `packages/db` (nodes, snapshots, settings).
- Docker: multi-stage image with server/agent roles; compose for the server.
- **Exit**: agent installed on one machine → live node card in the UI; SSE
  snapshot visible in browser devtools; validate + tests green.

## M2 — Telemetry core ✅ (05cf495; rollups + history API)

- Agent collectors: GPU per-card (usage/temp/power/VRAM/clocks/throttle/
  processes) via `nvidia-smi`, CPU (usage/temp/**package power**/clock) via
  sysfs/proc/rapl, memory (GB10 unified split / RAM+VRAM), storage, network.
- Server: snapshot ingestion + versioning, ring buffers, minute→hour→day
  rollups, retention prune, SSE fan-out. **Temperature minute buckets
  (min/avg/max per sensor) retained 7 d** — the Analytics Temps lens reads
  them (SPEC §9).
- **Mobile-first CSS** (390px verified): two-row scrollable topbar, stacked
  pageheads, single-column grids, full-bleed drawers/sheets, 44px targets,
  table scroll with sticky first column — no horizontal page overflow.
- Web: live Overview (worker card = memory/CPU/GPU/temp/package power; head
  card reserved until M3), node detail with sparklines, history ranges.
- **Exit**: two nodes streaming concurrently; charts live; rollups survive
  server restart; no unbounded tables.

## M3 — Inference monitoring ✅ (5ed4567; deployed dev-0.1.0-dev.3)

- Agent LLM probes: backend detection (vLLM, llama.cpp, SGLang, EXL3, TensorFold,
  q27, LM Studio, Ollama, ds4-server), decode/prefill tok/s, queue
  running/waiting, KV cache, TTFT p95 from `/metrics` where available; worker
  detection-only cadence 10 s.
- Web: head card primary surface (serving model, decode/prefill, queue
  run/total); cluster view grouping head+workers; per-port panels.
- **Exit**: serving engine on a head shows live rates + queue in cluster view.

## M4 — Model supply chain ✅ (5e4b534 + 46e3751 + 0b333e6; NAS↔dgx1 e2e)

- NAS node kind + agent model ops via modelctl subprocess (version pinned,
  install/upgrade job): catalog read (`catalog.json` + live-scan fallback),
  HF metadata join for search/recipe creation, download/queue (preflight,
  resumable, GGUF quant + companions), delete (dry-run → armed), doctor/
  repair/catalog-refresh with armed applies, cards.
- **Models page v2**: searchable/filterable/sortable table (25/page,
  recently-added default via Irori-side `first_seen_at` — catalog.json has no
  timestamp), detail drawer, download modal, hygiene popover.
- sync-local (NAS→node), push (node→node, CX7 parallel streams, `--host`
  round-robin), placement planning + capacity math.
- **Exit**: download a model on the NAS, sync to head, push to a worker over
  CX7 — all from the UI with streamed job logs.

## M5 — Serving orchestration ✅ (bd626db + a6bb7bd; TP-3 verified live)

- **Setup wizard**: type (single/cluster ≤ 8 nodes) → model (NAS search or
  chained HF download) → per-node existence check → **one start/stop script
  pair on the head** (scripts own ports/config and orchestrate workers),
  validated per start (`test -x`; stop required, fallback: recorded process
  group) → staged placement transfers (HF→NAS→head→workers, %/rate/ETA/
  cancel, capacity math, busy-node warning) → launch. Optional env exports
  (MODEL_NAME/PORT/EXTRA_ARGS/MODEL_PATH) for scripts that want them.
- **Setup cards UI** (homelab scale) + detail drawer: streamed engine logs,
  placement history, edit/duplicate/remove; armed stop required (fallback:
  recorded process group).
- **Exit**: serve GLM-5.3-flash cluster via the wizard: model staged
  NAS→head→worker, scripts validated, cluster started, logs streamed in UI.

## M6 — Benchmarks ✅ (0c35acc; four benches vs live engines)

- Decode, prefill, quality, tool-eval benches running via the agent against
  live engines; run lifecycle (202 + poll/cancel), persisted results, history,
  comparison views (quality paired compare; tool-eval side-by-side).
- **Exit**: all four benches complete against one engine; results queryable.

## M7 — Analytics, hygiene & packaging ✅ (PR #3; release artifacts at v0.2.0)

- **Disk hygiene (agent)**: audit job (per-category reclaimable: docker
  build cache/images/containers, HF orphans, modelctl staging, compiler/pkg
  caches, journal/tmp/cores/snaps), armed per-category clean with enforced
  protected set (modelctl registrations, running-container images, open
  files, <24 h files), opt-in docker log rotation + weekly always-safe pass;
  Cleanup drawer on Nodes; placement "Clean up disk — est. +N GB" remediation.
- Analytics section: memory / decode / power / tokens lenses, grouped and
  separated, per cluster + per node; token ledger (generated/cache/prefill);
  estimated power + monthly archive + Wh/token; temps.
- Packaging: multi-arch (amd64+arm64) images, agent install script + systemd
  unit, CI build/test/docs-check, semver release per RELEASING.md.
- **Exit**: analytics populated from rollups; agent deployed on a Spark from
  the release image; CI green.

## M8 — LLM usage capture & telemetry (≈1 week)

- **Capture proxy** (`packages/proxy`, in-agent, extractable): opt-in
  pass-through for OpenAI-compatible engines; per-request tokens (incl.
  cached/reasoning), TTFT, tok/s, finish reasons, errors, engine metrics
  (TensorFold prefill/decode/spec-decode), payload sizes — native wire
  capture working for every client (OMP, codex, benches). Rescopes the
  SPEC §14 deferred "inference gateway" to capture-only (research:
  `docs/research/IRI-009-research-brief.md`).
- **Data path**: in-memory ring (live) + SQLite WAL buffer on node →
  batched WS upload → Postgres `llm_requests` + hourly/daily rollups;
  exactly-once replay (UUID); **retention 90 d raw / 1 y rollups**;
  pgsql load = batched multi-row inserts per minute.
- **Setup opt-in** (M5 hook): flagged setups bind the engine to loopback
  and expose the LAN port via the agent proxy; health checks probe through
  it; un-proxied setups unchanged.
- **Usage UI**: Overview (KPIs/sparklines, activity chart, token mix),
  Requests (filters + detail drawer), Errors (signature groups), Models
  (TTFT/tok/s series); range selector + live SSE. No costs / providers
  (owner scope).
- **Deferred (phase 2, IR-51)**: body retention + chats reconstruction,
  tool attribution, client identity (`X-Irori-*` / per-client keys),
  retry lineage.
- **Exit**: live traffic through a flagged setup populates all four Usage
  pages; WS-outage + restart replay loses nothing; retention prune verified.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| modelctl version drift / missing on nodes | Pin minimum version; agent `doctor` check; install/upgrade job; store reads never require modelctl (catalog contract in `packages/core`) |
| `nvidia-smi` parsing varies across drivers | GB10-verified query set; tolerant parsers with fixture tests from real output; per-card fallbacks |
| Root agent = high-value target | Outbound-only WS, per-node tokens, revocation, no inbound ports, job allowlist modes; document homelab trust boundary |
| DS fidelity drift | Port uptime-monitoring's token/style/component recipes verbatim; verify against `Design System.dc.html` |
| Scope creep toward sparkDash parity | Milestones gate; non-goals in SPEC §1; deferred list §14 |
| Root agent vs container agent divergence | One bundle, one entrypoint, two install paths; contract tests on snapshot shapes |
