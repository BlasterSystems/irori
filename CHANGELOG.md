# Changelog

All notable changes to Irori are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/) (see `docs/RELEASING.md`).

## [Unreleased] — TensorFold-native probe classification (IR-125)

### Fixed

- **TensorFold 1.1+ engines misclassified as LM Studio** (IR-125): the probe's
  `/api/v0/models` branch now prefers the `owned_by` classification, so
  tensorfold-native builds (new health schema, LM-Studio-compatible model
  list) keep their identity and metrics instead of collapsing to the no-op
  lmstudio applier. Queue depth and KV fall back to the shared
  `tensorfold:` prometheus series when the health payload lacks the classic
  counter/pool block.

## [Unreleased] — NodeDetail overlay idiom (IR-122)

### Changed

- **Node model operations join the IRI-043 overlay idiom** (IR-122): the two
  hand-rolled confirm dialogs collapse into the shared confirm state machine,
  and the page-flow "Model operation" card becomes a job sheet on one scrim —
  job kind, status chip, full output, backdrop closes top-layer-first.
  Closing the sheet leaves a compact bar (status chip, last output line,
  Show output / Dismiss) so a running job stays one click away.
- **Cancel job is guarded on the node page** (IR-122): the confirmation
  renders inline in the sheet — the Models-page convention — instead of
  canceling the running job instantly.

## [Unreleased] — Push job default, overlay sheets, telemetry labels (IR-121)

### Added

- **Always-available telemetry drawer** (IR-121): a footer Telemetry CTA opens
  a right-hand dock on every page rendering the same event feed as the
  Overview card, including the new model labels. The left edge drags to
  resize (320–720 px, persisted per browser; full-width on mobile) and the
  panel layers above the page but below every dialog per the chrome z-order.
- **Job params on the SSE job frame** (IR-121): `job` events now carry the
  job `params` (older hubs omit the field; clients keep the seed value),
  so transfers started mid-session are labeled without a page reload — the
  settle and started events thread them through server-side.

### Changed

- **Overlay layers never stack** (IR-121, IRI-043 option C): job output opens
  as a side sheet docked beside the placement/download drawer on one shared
  scrim instead of a second centered modal; with no drawer open the job
  panel behaves exactly as before. Backdrop presses close the top layer
  first.
- **Destructive confirms are drawer-native** (IR-121): Delete-from-NAS
  (placement drawer) and Cancel-job (job panel) confirm inline in the
  hosting surface, mirroring the hygiene-drawer typed confirm; the shared
  confirm dialog remains for page-level queue and catalog rows.
- **Telemetry feed lines name the model** (IR-121): job progress and
  lifecycle lines read `DGX-3 · sync-local <model>: …`; download batches
  report `N models` instead of the first entry's name.
- **Pushes default to four parallel streams** (IR-121): the agent now
  defaults `push --jobs 4` when the hub omits the param — every hub path
  already sent 4 explicitly; API-created pushes no longer fall back to
  modelctl's single-stream default.

## [Unreleased] — Cache-user MODEL_PATH resolution + serve UX (IR-120)

### Fixed

- **MODEL_PATH resolution now runs as the node's cache user** (IR-120,
  IRI-042): the setup driver's `modelctl path --local` ran as the agent user
  (root) while every transfer dials the cache user's per-user modelctl — on
  nodes with `cacheUser` set the staged model lives in that user's HF cache,
  so `MODEL_PATH` setups failed to start with
  `MODEL_PATH resolution failed …` even though the model was staged (verified
  on DGX-1: root's resolution exited nonzero while the cache user's resolved
  the snapshot). Resolution now reuses the ADR-0011 runuser wrap (scrubbed
  env, per-user binary); a missing per-user modelctl refuses the start with
  that actionable reason instead of a bare banner, and resolution failures
  carry modelctl's stderr detail. The cache user reaches the driver via a
  getter, so runtime edits apply without an agent restart.

### Changed

- **Setup wizard scroll and model list** (IR-120, IRI-042): the wizard header
  and footer are sticky and the step body scrolls instead of the whole panel;
  the model list is scrollable (one 25-entry server page instead of a hard
  8-item truncation), shows each entry's repository under the name, and
  reports the total match count when the search yields more than one page.
- **Disk-hygiene clean CTA is always visible** (IR-120, IRI-042): the typed
  node-name confirm and `Clean N categories` button pin to the drawer bottom
  (with the `N selected · bytes` summary) instead of sitting below the fold
  behind the category rows; item counts pluralize.

## [Unreleased] — Setup edit repair (IR-119)

### Fixed

- **Setup edit deadlock on legacy worker rows** (IR-119, IRI-041): editing a
  setup created before the IR-78 worker validation (e.g. the fleet's
  `glm-5.3-flash-exl3-q4` row with DGX-2 ×1 / DGX-3 ×3 / NAS ×2) failed with
  `NAS is a NAS node and cannot be a worker` on every save path — the wizard
  loaded the stored rows verbatim while the TYPE step hid NAS, making the
  invalid rows invisible and unremovable. The wizard now sanitizes the worker
  list against the node inventory (dedupe keep-first, drop head-self,
  NAS-kind and unknown ids) on edit/duplicate load and on every persistence
  payload, so the first successful Save repairs the stored row; an empty
  inventory passes through untouched and lets the server validate.

## [Unreleased] — Token macro views in Analytics (IR-118)

### Added

- **Token macro views in the Analytics tokens lens** (`#/analytics` → tokens):
  five fleet stat tiles (total = generated + input, generated, input, cache,
  cache hit %), a By cluster / By node totals table folded from the lens
  series, and a per-model table upgraded with `total` / `cacheHitPct` columns
  backed by whole-ledger sums (never a top-N subset, capped at 100 rows).
  The `GET /api/v1/analytics/tokens` response is additively extended with
  `fleet` and the macro `models[]` columns. Sourced purely from engine
  lifetime counters via the agent probes — no capture proxy required, no new
  tables, no pricing.

## [Unreleased] — OpenTelemetry export (IR-116, IR-117)

### Added

- **Env-gated OTLP traces** (IR-116, IRI-039): with `OTEL_EXPORTER_OTLP_ENDPOINT`
  set, the capture proxy's agent exports one GenAI span per captured request —
  mapped from the already-parsed usage record (`gen_ai.usage.input_tokens` /
  `output_tokens` / `cache_read.input_tokens` / `reasoning.output_tokens`,
  `gen_ai.response.time_to_first_chunk`, finish reasons, HTTP status) and
  **parented by the client's `traceparent`**, which the proxy now attaches to
  the usage event and forwards verbatim; with vLLM's native
  `--otlp-traces-endpoint` the client → proxy → engine chain renders as one
  trace in any OTLP backend. The hub emits low-cardinality SERVER spans per
  request (`/healthz` skipped, UUID/numeric segments → `:id`). Export is
  fail-open (capture and traffic are never affected) and providers flush on
  SIGTERM; unset env leaves behavior byte-identical.
- **Pino + OTLP logs** (IR-117): both server and agent log structured JSON via
  pino (`IRORI_LOG_LEVEL`, default `info`); when the OTLP endpoint is set, log
  records also export via the OTLP logs pipeline. No prompt/response content
  is ever emitted on spans or log records.

## [Unreleased] — Usage phase 2: retention, chats, tools, client identity

### Added

- **Register-from-cache** (IR-104, ADR-0012): the models inventory reports
  unregistered `models--*` cache dirs per user, and the node page offers a
  Register action that runs the modelctl 0.23 `register-local` job — the
  entry is verified against the NAS object by hash (blob identity plus
  small-file content hashes) and registered with **no transfer**; any
  mismatch refuses the registration.
- **Modelctl convergence** (IR-106, ADR-0013): the modelctl pin is a hub
  setting (`modelctl_pin`, `GET/PUT /api/v1/settings/modelctl-pin`, pushed to
  agents via config-update — the node env stays as fallback);
  `modelctl-install` provisions a cache user's own modelctl via runuser and
  **skips without installing** when the current version already satisfies the
  pin (a stale env pin can no longer downgrade a newer binary); the hub
  auto-dispatches one install job per below-pin cache user after every
  succeeded models-inventory read (silent skip when the pin is unset, the
  node already has an active job, or the agent is offline).

- **Opt-in body retention** (IR-52, ADR-0010): per-setup `Keep bodies` flag
  (Serve wizard) with global caps (settings key `usage_body_retention`,
  defaults 16 MiB body / 4 MiB part); the capture proxy decomposes bodies
  into sha256-addressed gzip parts (deduped across turns, in-position
  truncation markers), the agent buffer stores bytes once and batches under
  the WS frame limit, and Postgres `llm_parts`/`llm_request_parts` refcount
  parts so they die with their owning rows (migration 0012).
- **Chats** (IR-53): read-time session chaining (client key + 30-min gap +
  prefix-hash extension; broken chain + >50% input drop marks `compacted`)
  and reconstruction of exactly what the model saw — `#/chats` renders
  sessions per client/day with byte-exact images, collapsed tool blocks and
  truncation/compaction markers; retention-off shows guidance instead of
  errors.
- **Tool attribution** (IR-54): `tool_call` deltas reassembled by index and
  `role:"tool"` results lifted at capture time (retention-independent);
  ingest attributes tokens largest-remainder per (request, tool) so shares
  sum exactly to request totals; `unknown` fallback for unresolved ids;
  Tools tab with per-tool×model table + top-8 token series (migration 0014).
- **Client identity** (IR-55): issued per-client keys (fingerprinted sha256
  at the proxy, shown once), `X-Irori-Project`/`X-Irori-Agent-Type`/
  `X-Irori-Client` headers, `X-Irori-Retry` lineage contract; issued keys
  win over self-declared headers, unidentified clients stay visible by
  source IP; Agents tab + Client keys manager; project/agent-type filters
  on Requests (migration 0013).

### Changed

- Agent modelctl pin default raised to `0.23.0` (IR-104): `register-local`
  requires the per-user modelctl to know the verb.
- Agent modelctl pin default raised to `0.22.0` (IR-75): modelctl now emits
  `progress:` JSONL on stderr during real downloads, lighting up the
  download-queue rows, batch totals strip and job-drawer summary shipped in
  IR-71/74.

### Fixed

- **Node page UX** (IRI-034): saving probe ports (or role / NAS root / cache
  user) pushes a live `config-update` so the agent stops probing removed
  ports immediately instead of ghosting them until the next reconnect; port
  panels render configured ports plus detected hot-added ports only (idle
  ghosts hidden); the node-page store catalog renders only on the store node
  (`kind: nas`); the History CPU card shows the current clock like the GPU
  card (`cpu X / Y MHz` — the max half once agents report
  `perCoreMaxClocksKHz`).

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
