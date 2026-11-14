# Changelog

All notable changes to Irori are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/) (see `docs/RELEASING.md`).

## [Unreleased]

### Fixed

- **Cleanup drawer fits without scrolling at desktop heights, and overlay
  scrims no longer lose to the topbar** (IR-229 follow-up): the drawer body
  is compressed to mockup density (audited-but-empty categories collapse to
  one-line micro rows — rationale, breakdown and weight bar only render
  when a category has something to reclaim; the checkbox contract is
  unchanged), the hygiene drawer caps at 92vh like the mockup, and the
  body scrollbar is a hairline fallback for data taller than the drawer.
  All overlay scrims (drawers, NodeModal, HubSettingsModal, ModelsView)
  rise from z-index 10 to 40 — the sticky topbar (z 20) was painting over
  the first ~28px of any tall drawer, clipping its title row.

### Added

- **Round-8 shell controls + Overview token stats** (epic IR-224): the
  range control and the Add node CTA live in the sidebar menu (hamburger
  ≤900; the collapsed 68px icon rail shows an Add node icon plus a
  JS-positioned range popover) with vendored lucide-style nav icons — no
  CDN; the topbar gains an inference-server performance chip (live decode
  plus fleet watts) on every route except the Overview, whose serving
  heroes carry the same data. The range is one persisted store
  (`irori.range`, default 24h) driving the serving heroes and the new
  Token stats card, while the power card is pinned to the 24h window and
  Fleet now plus the per-node barrows read live snapshots (minute-fresh at
  every range). The Token stats card sits directly below the NAS card —
  eight tiles, per-stat deltas from one prev-window fetch, all-nodes fleet
  scope, the NAS token block folded away. The cleanup drawer never scrolls
  as a panel (fixed head, scrolling body, always-visible typed-confirm
  foot, collapsed staging/quarantine section), and the ≤720 drawer
  visibility gate is gone (five drawers were statically invisible on
  phones).

- **BlasterSystems DS v1.1 across the web UI** (ADR-0018, epic IR-214):
  oklch tokens verbatim (dark paper `#0e1217`), a 232px paper-2 sidebar
  shell with topbar chrome and a 900px hamburger menu (IR-217), ink action
  buttons with one filled per visible surface, destructive actions as
  thread-ink text links, underline form fields, a labeled chart idiom
  (44px y column, hairline grid, mono uppercase x labels, legend
  swatches), the v1.1 media tiers alongside the data-tier machinery, and
  Irori-owned force-dark log/table/tip treatments. The Overview, Serve and
  Models screens plus every remaining route render the v1.1 skin; the
  IR-197 footer is superseded (version/watts live in the sidebar foot and
  the refresh-note, the deploy tag keeps its hamburger-menu home).

- **Serving survives agent death** (ADR-0017, IRI-144): setups now spawn
  inside a `iroori-setup-<slug>` systemd transient scope — the engine's
  cgroup leaves the agent unit, so an agent restart, crash loop, or
  self-update never kills a running engine. The scope unit name is
  persisted in the driver record; `stop()` prefers
  `systemctl stop <unit>` after the stop script; boot adopts a still-active
  scope even when the recorded process group is gone (daemonizing
  engines). Hosts without systemd fall back to the previous detached
  spawn. The `agent-update` job refuses while an unscooped setup runs
  (ground truth), and the hub's 409 guard relaxes for agents that report
  the `scopeIsolation` hello capability (in-memory on the hub; old agents
  and pre-hello hubs keep the refusal).

## [0.7.0] — 2026-11-11

### Added

- **Bulk store delete** (IR-207): the Models page multi-selects store rows
  and dispatches ONE `nas-delete-batch` job to the store node — per-model
  plan → preflight → apply inside the agent, one structured output line per
  model plus a final summary, a failed model never stops the batch. The
  confirm modal lists every name with the catalog-sourced byte total and
  warns about serving setups that reference any selected model. The agent
  reports version 0.7.0; the action is gated on that version in the UI.
- **Staging & quarantine audit** (IR-207): the node cleanup drawer audits
  the store's `.staging` including the hidden dot-dirs `staging-audit`
  cannot see — `.active-quarantine` trees per model (prunable through
  `modelctl cleanup-quarantine`, which validates the repaired reference
  before deleting) and `.cleanup-quarantine` trees (report-only until
  modelctl grows a prune command), with per-tree sizes, totals, and the
  statfs freed-bytes delta.
- **Download free-space floor** (IR-207): `download` and `download-queue`
  jobs refuse to start when the store volume's free space is below
  `IRORI_MIN_STORE_FREE_BYTES` (default 1.5 TiB; `0` disables), naming the
  measured free space and the floor.

### Fixed

- **Models cache self-heal** (2026-11-10): the hub prunes `model_meta` rows
  absent from a complete `catalog` frame and re-reads the catalog after
  failed store-mutating settles, so out-of-band store changes reconcile
  without manual surgery.

## [0.6.0] — 2026-11-06

### Added

- **Clock caps re-apply on node online** (IR-189): every authenticated agent
  hello now re-asserts the stored GPU/CPU caps — the hub reads the live
  clocks, compares each side with the applied ceiling, and re-applies only
  what drifted, without touching persistence. This is the SPEC §10 promise
  that was never implemented; a DGX OS component rewriting
  `scaling_max_freq` after boot no longer silently reverts a cap.
- **Clock-cap drift health rule** (IR-189): a `clock_cap_drift` rule trips
  after 4 consecutive 30 s sweeps (two minutes) of a live ceiling differing
  from the stored cap. Offline nodes and unreadable readings never breach.
- **Fleet-wide clock caps** (IR-189): `POST /api/v1/clock-cap` applies the
  per-side cap contract to every enabled spark node and returns per-node
  results (200 all, 207 partial, 502 none); the Overview page gains the
  matching control.

### Fixed

- **Boot migrations converge an out-of-band schema** (IR-188): the hub no
  longer boots `db:false` when its schema exists without matching
  `drizzle.__drizzle_migrations` rows. Pending is decided by hash membership
  instead of a `MAX(created_at)` watermark, and duplicate-object SQLSTATEs
  (42P07/42701/42P06/42710/42723) are tolerated per statement and logged with
  the journal tag, so the migration is recorded and the boot proceeds. Any
  other error still rolls that migration back and fails the boot.
- **Agent frame trace no longer logs at error level** (IR-190): every routine
  agent frame (usage-batch, log-batch, setup-event, job-output) was written
  with `log.error`, so the hub log was a wall of level-50 lines and real
  failures were invisible. The trace is now `log.debug`; the parse-failure
  line above it stays at error.

## [0.5.1] — 2026-11-05

Node-page feedback round 6 and CPU underclocking (IR-180). The node page gets
a readable header, preset clock caps for GPU **and** CPU, temperature overlays
on the history charts, and network rows that stay inside their card. Wire
changes are additive; the CPU half needs the 0.5.1 agent.

### Added

- **CPU underclock** (IR-185/IR-186): a per-policy `cpufreq`
  `scaling_max_freq` ceiling (`min(cap, cpuinfo_max_freq)`, clamped to the
  policy minimum) applied by the root agent, with presets 1400/2000/2800 MHz,
  a per-cluster effective read-back, and a boot-time re-apply oneshot
  (`irori-cpu-clock-cap.service`). A cap is a uniform ceiling: 2800 limits
  both GB10 clusters. `clocks-set` gains `cpuMaxMHz`, `clocks-get-result`
  gains an optional `cpu` block (absent = older agent, `null` = no cpufreq),
  and `nodes` gains `cpu_clock_cap_mhz`/`cpu_clock_cap_persistent`
  (migration 0023).
- **GPU clock cap presets** (IR-182): the SM cap is a select
  (1800/2000/2200/3000 MHz) that keeps a stored non-preset value visible as
  `(current)`.
- **Temperature overlay** (IR-183): the CPU and GPU history charts draw the
  bucket-average temperature as a dashed second series on its own scale, with
  a two-row tooltip and a legend.
- **Node header and network rows** (IR-181/IR-184): the header action row
  wraps instead of squeezing the title to one glyph per line, and interface
  address lists wrap inside the card.
- **Reconnect-storm detection + process guards** (IR-179): a per-node
  `node-online` journal-rate health rule (seeded, webhook-capable) trips on
  crash-loop reconnect patterns; `unhandledRejection`/`uncaughtException`
  handlers log structured diagnostics and surface counters on `/metrics`.

### Changed

- **Clock-cap API** (IR-185): `PUT /api/v1/nodes/:id/clock-cap` moves the GPU
  and CPU caps independently (absent = untouched, `null` = clear), bounds
  values to 300–4000 MHz, applies one agent frame per side and reports
  per-side results, so a landed half is stored even when the other fails.
  `POST /clocks` is a one-shot apply that never touches persistence.
- **Agent usage size-bounding** (IR-178): batches are budgeted on serialized
  row bytes (base64 parts + non-part payload — the wire unit) instead of gz
  bytes with a first-event bypass; single events over
  `USAGE_EVENT_HARD_CAP_BYTES` (56 MB) are quarantined with metadata kept,
  and a 1009 close halves the next take until a batch acks.

### Fixed

- **GB10 clocks query** (IR-187): `clocks.applications.sm` is not a valid
  `--query-gpu` field on the GB10 driver and one bad field failed the whole
  call, so `GET /api/v1/nodes/:id/clocks` answered 502 on every Spark. The
  base query now carries the six valid fields; the application clock is a
  separate best-effort probe.
- **Migration watermark** (IR-124): a future-dated journal `when` (0019)
  made drizzle skip every later migration on any database that applied it.
  `migrate()` now restores impossible `created_at` values from the journal
  before running the migrator, and logs what it rewrote.
- **Node DTO clock caps** (IR-124): the node payload now projects
  `gpuClockCap*`/`cpuClockCap*`, so the controls re-seed from the registry
  instead of reading as "no cap" after every navigation.
- **Persistent clear** (IR-124): clearing a cap with `persistent` now reaches
  the agent and removes the boot-time unit (it used to be a 400, leaving a
  stale oneshot that resurrected the cap at the next boot).
- **Agent-update settlement** (IR-124 rollout): the agent's own restart kills
  the `systemd-run` child, so the dying agent reported `job-done failed` with
  a null exit code while the update had actually landed. That frame is now
  ignored — the version check (or the grace reaper) owns the row — so a
  successful rollout no longer shows as failed.
- **Hub survives oversized agent frames** (IR-176/IR-177): an agent
  usage-batch frame over the WS cap no longer kills the hub with an
  unhandled socket error — it is logged and closed 1009; the frame cap is
  env-tunable (`IRORI_MAX_FRAME_BYTES`). Deployed as the 2026-11-04 incident
  hotfix (`dev-0.3.0-67`).

## [0.5.0] — 2026-11-04

The observability epic (IR-157): fleet-wide costs, energy, health, logs and
traces — plus transfer hardening and capture/token-coverage fixes. Nothing
breaking; all new capability is additive to existing endpoints and the wire
schema.

### Added

- **Cost engine** (IRI-072): per-model pricing snapshots with hour+day
  bucket stamping and a resumable backfill; every usage surface gained cost
  fields priced per model, with an unset-pricing CTA where no snapshot
  exists (IRI-074).
- **Tokens lens** (IRI-075/076): computed/cached token split with
  delta-vs-previous tiles, cache-hit rates, setup grouping, insight line,
  CSV export, and an hourly cost trend from per-bucket ledger pricing;
  retry-waste view (superseded attempts priced per client key), cost of
  errors by signature, and per-session chat cost.
- **Trace inspector** (IRI-079): typed queue/prefill/decode timings parsed
  from engine meta, a span-tree endpoint, request-drawer waterfall with p50
  comparison, failing-segment highlight and audit cross-link.
- **Energy per token** (IRI-073): Wh-per-token efficiency endpoint joining
  power buckets with the token ledger.
- **Health + alerts** (IRI-069): rules engine with webhook alerts and a
  Prometheus `/metrics` export (flag-gated); web thresholds now come from
  the API.
- **Power actions** (IRI-068): armed shutdown, Wake-on-LAN and persistent
  clock cap per node.
- **Telemetry parity** (IRI-067): link detail, storage I/O, memory
  bandwidth and kernel counters, plus clock endpoints.
- **Token coverage** (IRI-071): sglang cumulative token counters on the
  agent and ledger-vs-capture reconciliation with a divergence warn chip.
- **Durable logs + audit** (IRI-077/078): ring-buffered log pipeline with
  levels, search and typed retention that survives agent restarts
  (engine-log capture included), plus an audit/event journal with a
  cleanup drawer.
- **Usage quarantine** (IRI-070): rejected usage events are quarantined
  instead of dropped; requests store W3C trace ids.
- **Version provenance** (IRI-080): per-node agent/uv/catalog versions with
  a drift endpoint and a VERSIONS section in node detail.
- **Fleet posture** (IRI-081): OS/firmware/driver update availability per
  node.
- **Curated recipes** (IRI-082): recipe catalog with staged installs into
  the serve wizard.
- **Community intelligence** (IRI-083): external pollers and a community
  page.
- **Transfers** (IR-133/134/148): orphaned transfers adopt with a Resume
  CTA, relay-busy names the blocking job, and the setup-log feed relaxes to
  ~10 fps while starting.
- **Security**: forced body-parser ≥2.4.0 (high), glob ≥14.0.2 and
  minimatch ≥11.0.1 (dependabot alerts).

### Changed

- Poll truth defers to the probe; stop is always forwarded (IR-151).

### Fixed

- Proxy captures OpenAI endpoints with or without the `/v1` prefix
  (IR-154), and tensorfold/exl3 probes emit cumulative token counters
  (IR-153).
- Placement reconciles node presence from the models-inventory report
  (IR-140).
- Boot-time schema repair heals journals ahead of the schema (live-fleet
  500 on `wol_mac`), and 5xx diagnostics surface the error message in the
  response body.

## [0.4.0] — 2026-10-31

Ten days of capability work since 0.3.0: usage phase 2 (retention, chats,
tools, client identity), OpenTelemetry export, cache-user execution
everywhere, push self-healing, job persistence across agent restarts, auto
node-role adjustment, and a serve-wizard/placement UX round. **Two
intentional behavior changes to call out:**

- **Serve start/stop scripts — and MODEL_PATH resolution — now run as the
  node's `cacheUser`** instead of the agent user (root). A cache user needs
  GPU device access and must own the model paths (IRI-045 / IR-120,
  ADR-0015).
- **Node roles auto-derive from serving-setup membership** (head over worker
  over standalone) on every setup create/edit/remove; a manual role still
  works but is overwritten the next time that node's membership changes
  (IRI-050).

### Added

- **Usage phase 2** (IR-52/53/54/55, ADR-0010): opt-in per-setup body
  retention (sha256-addressed gzip parts deduped across turns, global caps,
  migration 0012), read-time chat chaining with byte-exact reconstruction
  (`#/chats`), tool-call attribution with exact largest-remainder token
  shares (migration 0014), and per-client issued keys with
  `X-Irori-Project` / `X-Irori-Agent-Type` / `X-Irori-Client` headers,
  `X-Irori-Retry` lineage and an Agents tab (migration 0013).
- **Register-from-cache** (IR-104, ADR-0012): the models inventory lists
  unregistered `models--*` cache dirs per user and registers them via
  modelctl 0.23 `register-local` — hash-verified against the NAS object
  with no transfer.
- **Modelctl convergence** (IR-106, ADR-0013): the modelctl pin is a hub
  setting (`GET/PUT /api/v1/settings/modelctl-pin`, pushed to agents via
  config-update) and `modelctl-install` skips when the installed version
  already satisfies the pin — a stale env pin can no longer downgrade a
  newer binary; the hub auto-dispatches one install per below-pin cache user
  after every succeeded models-inventory read.
- **OpenTelemetry export** (IR-116/117): with `OTEL_EXPORTER_OTLP_ENDPOINT`
  set, the capture proxy emits one GenAI span per captured request (parented
  by the client's `traceparent`), the hub emits low-cardinality SERVER
  spans, and both server and agent export pino logs — fail-open, byte
  identical when unset, and no prompt/response content on any span or record.
- **Token macro views** (IR-118): five fleet stat tiles, by-cluster/by-node
  totals and per-model `total`/`cacheHitPct` columns in the Analytics tokens
  lens, sourced from whole-ledger engine counters (no capture proxy, no new
  tables, no pricing).
- **Push self-healing** (IR-112, ADR-0014): push jobs preflight the
  destination and self-provision its dependencies (rsync, per-user modelctl,
  authorized key exchange orchestrated by the hub) — a first-time dgx-to-dgx
  push no longer dies on an ambiguous "modelctl is not installed" error;
  private keys never leave the node and the hub stores no credentials.
- **Job persistence across agent restarts** (IR-131, migration 0019): agents
  persist active jobs, kill persisted process groups on boot and report them
  in `hello`; the hub settles any running/canceling row the fresh agent no
  longer reports instead of stranding it, and `jobs` gained cancel-requested
  and parsed-progress columns.
- **Transfer tracking and cancel** (IRI-048): a running sync-local/push
  stays reachable after its sheet closes — persistent op bar plus the global
  transfers dock, aggregate modelctl progress (bytes, percent, rate, eta),
  and a guarded cancel with honest offline/crash reconcile.
- **Auto node-role adjustment** (IRI-050): node roles derive from
  serving-setup membership (head over worker over standalone, dangling ids
  ignored) on every setup create/edit/remove, written as a write-only diff
  per changed node with a live config-update — workers probe detection-only
  at 10 s the moment they join a cluster; node delete strips dangling worker
  ids from setups so no ghost worker rows render.
- **Serve-wizard and placement UX round** (IRI-051): the wizard prefills the
  serving port on edit/duplicate, asks for a recipe folder plus start/stop
  names, and reviews grouped Runs / Port and health / Scripts / Environment
  with placement node names and env values; the model picker renders the
  whole catalog name-ordered (numeric, case-insensitive) in two columns; the
  placement table separates state from action with role subtext, and the job
  sheet carries target context plus a hub-parsed aggregate progress line
  with raw output collapsed and a live `syncing N%` chip from the SSE job
  store.
- **Always-available telemetry drawer** (IR-121): a footer Telemetry CTA
  docks the Overview event feed on every page (left edge resizable,
  persisted); `job` SSE frames carry `params` so mid-session transfers are
  labeled without a reload.
- **Settings and quants endpoints** (IR-101/106/118, IRI-016):
  `GET/PUT /api/v1/settings/*` for the HF token, cadence, energy/token cost
  and modelctl pin, plus `GET /api/v1/hf-quants` backing the download
  modal's Expand flow.

### Changed

- **Cache-user execution everywhere** (IRI-045/120, ADR-0015): transfers,
  local ops, inventory, MODEL_PATH resolution and serve start/stop all run
  through one `runuser` wrap (scrubbed HF/env, per-user binary and home); a
  missing per-user modelctl or passwd entry refuses with an actionable
  error instead of silently running as root.
- **Node roles are derived, not hand-maintained** (IRI-050) — see the
  behavior callout above.
- **Pushes default to four parallel streams** (IR-121/131): the agent
  defaults `push --jobs 4` and the hub emits no parsed progress for
  multi-stream transfers — the UI shows raw output rather than one stream's
  stats presented as an aggregate.
- **Overlay layers never stack** (IR-121/122, IRI-043): job output docks as
  a side sheet beside an open drawer on one shared scrim (backdrop closes
  the top layer first); destructive confirms render inline in the hosting
  surface; telemetry feed lines name the model.
- **Agent modelctl pin default raised to 0.23.0** (IR-104) and **0.22.0**
  (IR-75): register-local and download progress need the newer verbs.
- **Disk-hygiene clean CTA pins to the drawer bottom** (IR-120) instead of
  sitting below the fold behind the category rows.
- **CI/CD moved to the self-hosted runner** (PR #75): GitHub-hosted build
  minutes are exhausted, so the verify/docs-check/test gate runs on
  `iroiri-dev-vm` (LXC 110) with a throwaway per-job Postgres cluster; the
  deploy job and rollback path are unchanged.

### Fixed

- **NAS store staging no longer counts as a compute node's reclaimable
  disk** (IRI-047): the `modelctl-staging` audit category is scoped to the
  store node by identity — 236 GB of orphaned staging used to render in
  every NAS-mounted node's Disk hygiene drawer and reclaimable total.
- **TensorFold 1.1+ engines misclassified as LM Studio** (IR-125): the probe
  prefers the `owned_by` classification so tensorfold-native builds keep
  their identity and metrics; queue depth and KV fall back to the shared
  `tensorfold:` prometheus series when the health payload lacks the classic
  counters.
- **Agent boot crash-looped on nodes with persisted setup state** (IR-125):
  the setup-driver re-attach ran before the transport existed and fataled on
  every restart; driver init now runs after the transport is built.
- **Setup edit deadlock on legacy worker rows** (IR-119, IRI-041): the
  wizard sanitizes stored worker lists (dedupe keep-first, drop
  NAS/self/unknown) on edit/duplicate so the first successful Save repairs
  rows created before IR-78 validation instead of failing every save path.
- **`set -u` start scripts no longer die on `$HOME`** (IRI-045): the driver
  injects the agent user's passwd home when neither the ambient env nor the
  setup env has one.
- **Node page UX** (IRI-034): probe-port (and role / NAS root / cache user)
  saves push a live `config-update` so agents stop probing removed ports
  immediately; idle ghost ports are hidden; the store catalog renders only
  on the store node; the History CPU card shows the current clock like the
  GPU card.
- **Engine output and cancel reconcile** (IR-124): setup logs stream into
  the shared hub feed throttled and deduped, and cancel reconcile is honest
  about what actually stopped.

## [0.3.0] — Agent onboarding, usage capture, download queue & overview

### Added

- **Hub-served agent onboarding** (IRI-011 / IR-57, ADR-0007): the hub serves
  `install-agent.sh`, `irori-agent.service` and its own version's agent bundle
  (`GET /agent/irori-agent.mjs`); the Add-node modal offers the download and a
  copyable install block — nodes need no GitHub reachability.
- **One-click agent updates** (IRI-012 / IR-58, ADR-0007): agents ≥ 0.3.0
  update themselves to the hub's version over the existing WS link
  (`POST /api/v1/nodes/:id/agent-update`); the bundle replace runs in a
  `systemd-run` transient unit, keeps the previous bundle as `.bak`, and the
  job settles from the node's next hello. Busy nodes (active job, running
  bench or setup) and agents older than 0.3.0 are refused — the latter get
  the install one-liner once.
- **LLM usage capture** (IRI-009 / IR-42…50, ADR-0008): opt-in per-setup
  pass-through capture proxy (`packages/proxy`) — byte-identical streaming,
  fail-open passive tee with backpressure; agent-side SQLite WAL buffer +
  batched WS sync (exactly-once by UUID, ack-driven deletion); Postgres
  `llm_requests` + ingest-time buckets with watermark-guarded hourly/daily
  rollups; retention 90 d raw / 1 y buckets; `/api/v1/usage/*` read API; the
  four Usage pages (Overview, Requests, Errors, Models) with URL-hash ranges
  and live SSE.
- **Overview v1** (IRI-013 / IR-59…62): fleet landing page with lens segment,
  head hero 6-stat serving grid, power card, NAS card and the all-in-one
  telemetry feed (bounded recent-events ring + `GET /api/v1/events/recent` +
  new `job-done`/`thermal` SSE emitters); worker PKG power row and
  disk-warn cleanup chip.
- **Server-side download queue + NAS placement** (IRI-014 / IR-63, ADR-0009):
  adding a download always queues (durable `download_queue` table, migration
  0011) — no more 409 dead-ends; pending entries drain as one
  `download-queue` batch on the NAS-preferred store node (shared
  `pickStoreNode` policy), dispatched on enqueue/settle/reaper tick/boot;
  per-entry reconcile from modelctl output; retry reuses published objects;
  web queue panel.
- **Bulk download modal** (IRI-015 / IR-64): paste one `owner/model` per line
  → deduped editable rows → one atomic batch (`POST /api/v1/downloads`
  `{downloads, jobs}`, 1–50, any invalid entry rejects all); the server-side
  reconcile prefers modelctl's `queue --json` results document (modelctl
  ≥ 0.21.0) with the terminal-line parser as fallback.
- `GET /api/v1/version` plus agent-version drift chips on the nodes list and
  drill-down with an Update action.
- `docs/CONFIGURATION.md`: the env surface for server, agent, and web.

### Changed

- `SPEC.md` §13 corrected to the shipped routes (removed the never-built
  `/:id/install-agent`, the wrong rotate path and the nonexistent
  `POST /api/v1/nodes/:id/test`).
- Agent modelctl pin default raised to 0.21.3; the `modelctl-install` job
  force-installs the pinned tag and hard-gates the installed version.
- Dev deploy tags move to `dev-<version>-<n>` (IR-67); historical tags keep
  their names.

### Fixed

- **Fleet self-update defects** (all found live during the 2026-10-21
  rollout): `systemd-run` argv `$`-expansion ate the update script's shell
  expansions (`--expand-environment=no`); the install job's `PATH` export
  degraded under the HOME-less agent unit (`/root/.local/bin`); the update
  syntax check moved to a `.mjs`-named file with the agent's pinned node.
- **Unresolvable agent-update jobs** (IR-68): the generic
  `POST /api/v1/nodes/:id/jobs` endpoint rejects `agent-update` (400, use the
  dedicated endpoint); `settleAgentUpdate` settles malformed jobs failed on
  hello instead of blocking the node forever.
- Capture proxy: response backpressure (upstream pauses when the client
  stops draining); capture-proxy leak on spawn failure (failed setup event
  now emitted); transport field typed for the `capture` param.
- Download queue: orphaned running rows (node deleted mid-batch) settle
  failed instead of wedging; concurrent remove no longer echoes undefined
  entries; usage-sync flush wrapped (agent crash guard).
- Docker image builds `@irori/proxy` (the agent bundle failed to resolve it).

## [0.2.0] — M7 Analytics, disk hygiene & packaging

### Added

- **Analytics section** (SPEC §9): five lenses over the rollup buckets —
  memory, decode, power, temps, tokens — groupable by serving cluster and by
  node, with 1h/24h/7d/30d/90d ranges. Temps read minute buckets for 7d with
  min/max pairs, 85/90 °C guide lines and throttle/crossing markers; power is
  **estimated, not wall-metered** (GPU board + CPU package + base overhead,
  clamped to the 240 W GB10 envelope, explicit coverage).
- **Token ledger** (per model, hourly + daily): generated/prompt/cached
  deltas diffed from the probes' cumulative counters (vLLM, llama.cpp, q27,
  ds4 publish them; other backends record coverage as "not detected").
- **Monthly energy archive** with Wh/token computed from the ledger.
- **Disk hygiene** (SPEC §11.6): read-only audit of eight clutter categories
  with per-category safety rationale; armed per-category clean (dry-run plan →
  typed node-name arm → staged streamed run) under an enforced protected set
  (modelctl registrations, running-container images, `/proc` open files,
  <24 h files, the NAS store); opt-in prevention (docker `daemon.json` log
  rotation + weekly always-safe pass); Cleanup drawer with Audit | History
  tabs and two-tier 80/90 % disk chips on node cards; placement capacity
  failures offer "Clean up disk — est. +N GB".
- **Packaging**: multi-arch (amd64+arm64) GHCR images for the `server` and
  `agent` roles on `v*` tags; agent install script + root systemd unit as
  release artifacts.

### Fixed

- Adversarial-review batch (PR #2): stale agent socket deregistering a
  reconnected node; CD rollback capturing the previous image after the build
  retagged it; transfer recovery skipping an interrupted stage; tool-eval
  400-retry sending a body without `messages`; daemonized engines becoming
  un-stoppable; unpinned `modelctl-install`; missing zombie-socket detection;
  terminal job/bench frames lost on disconnects stranding the one-active slot;
  ServeView frozen probe data and cross-card stage bleed; plus 20+ minor
  hardening and correctness fixes (see PR #2 for the full list).

## [0.1.0] — Foundations through benchmarks

- M1 walking skeleton, M2 telemetry core, M3 inference monitoring, M4 model
  supply chain, M5 serving orchestration, M6 benchmarks.
