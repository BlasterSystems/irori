# Changelog

All notable changes to Irori are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/) (see `docs/RELEASING.md`).

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
