# API behavioral contract

Endpoint inventory lives in `SPEC.md` §6; this file records the behavioral
guarantees callers rely on, kept current when behavior changes. Last updated
2026-10-20 (M8 usage capture).

## Usage capture (M8, ADR-0008)

- `GET /api/v1/usage/overview|requests|errors|models?range=` — ranges
  `1h|24h|7d|30d|90d` (same enum as analytics); unknown range → `400`;
  degraded DB → `503`. Shared filters: `nodeId` (uuid), `model`.
  `requests` adds `errors=1`, `sig=<errorSig>`, `status`, `page`,
  `limit` (1–200, default 50); a row's full record is
  `GET /api/v1/usage/requests/:id` (404 unknown).
- Overview/models series read the watermark-guarded `usage_buckets`
  (hour for 1h/24h/7d, day for 30d/90d) keyed on **server ingest time**
  (`received_at`); the requests list and detail read raw `llm_requests`
  (90 d retention; buckets 1 y).
- Every captured request is also an SSE `usage` event (`{serverTimeMs,
  nodeId, request}`) sent after the durable insert; the events feed keeps
  them (only heartbeat/snapshot/llm are excluded).
- Agent sync: `usage-batch` frames (≤500 events) insert with
  `ON CONFLICT (id) DO NOTHING` and are answered with
  `usage-batch-ack {ids}` **only after** a successful insert — a failed or
  degraded insert sends no ack, and the agent's SQLite buffer redelivers.
  Redelivery is a no-op by UUID (exactly-once).
- Setups: `captureProxy` on create/patch flips the head's engine port to the
  agent's capture proxy. Flagged setups get **no `PORT` env from the
  server** — the agent binds the declared port and injects a fresh loopback
  engine port as `$PORT` at spawn (the start script must honor it). Health
  probes and LLM probes target `127.0.0.1:<port>` and work through the
  proxy unchanged; unflagged setups are byte-identical to before.

## Download queue (IRI-014, ADR-0009)

- `POST /api/v1/downloads` `{source, name?, quantization?, mtp?, force?,
  jobs? (1–16, default 4)}` — **always queues**: `202 {entry}` with the row in
  `pending` (or already `running` when the store node was idle and the batch
  dispatched immediately). Adding a download NEVER starts a one-off per-node
  job and never returns 409. Invalid payload → `400`; degraded DB → `503`.
  IRI-016: `quantization` is the modelctl `--quantization` substring (GGUF
  repos with several quants require it); `mtp` is an explicit draft
  companion path (modelctl otherwise auto-selects the single root
  `mtp-*.gguf`). A quantized entry without an explicit name derives
  `{repo tail}-{TAG}`. IRI-017: `force` opts the entry into replacing an
  existing manifest with different settings (modelctl per-entry `force`;
  without it a conflicting manifest fails the batch preflight).
- **Bulk form (IRI-015)**: `POST /api/v1/downloads`
  `{downloads: [{source, name?, quantization?, mtp?, force?}…] (1–50),
  jobs?}` → `202 {entries}` (same per-row states). Atomic: any invalid entry
  rejects the whole submission with `400` and nothing lands. Single-row bulk
  submissions are equivalent to the single shape.
- The server picks the store node (`pickStoreNode`: `nas`-kind node with
  `nasRoot` first, then any online node with the store mounted). Pending
  entries drain as **one `download-queue` batch** on the idle node — drained
  on enqueue, on any job settle, on the 60 s reaper tick, and at boot.
- `GET /api/v1/downloads` → `{entries}` (newest first, last 50);
  `DELETE /api/v1/downloads/:id` removes a pending or terminal row (404
  unknown, 409 while the entry is in the running batch — cancel the job
  instead); `POST /api/v1/downloads/:id/retry` re-queues a failed/canceled
  row (409 otherwise) — body `{force?: true}` opts the retry into manifest
  replacement (IRI-017).
- Batch reconcile: job `succeeded` ⇒ every entry succeeded (modelctl exits
  non-zero if any entry failed); `canceled` ⇒ entries canceled; `failed` ⇒
  per-entry status from the modelctl `queue --json` results document
  (single-line JSON, last stdout line — IRI-015) when the pinned modelctl
  emits it, falling back to the `[i/n] complete|failed` output lines
  otherwise; unmatched entries fail with "did not complete in the batch".
  Partial failure/cancel still triggers a catalog refresh. Retry is cheap:
  modelctl reuses published objects and resumes staging.

## HF quantization listing (IRI-016)

- `GET /api/v1/hf-quants?repo=owner/model` — read-only proxy of the public
  HF API for the download modal's expand-quants flow. Returns
  `{repo, modelCard, quants: [{tag, files, sharded, shards, bytes,
  ambiguous}], companions: {mmproj: {candidates, default}, mtp: {candidates,
  default}}}`. `tag` is a substring needle unique across the repo's GGUF
  groups (pass it as `quantization`); `ambiguous` rows cannot be selected.
  Companion `default` is modelctl's auto-pick (single f16 mmproj / single
  root `mtp-*.gguf`); null means modelctl needs an explicit choice.
  Errors: `400` invalid repo id, `404` missing/not public, `502` HF
  unreachable or unusable response. No store required (works degraded).
  IRI-019: when a global HF token is configured, the upstream request carries
  `Authorization: Bearer <token>` (gated/private repos answer); without one
  the request is unchanged.

## Hub settings — global HF token (IRI-019, ADR-0009)

- `GET /api/v1/settings/hf-token` → `{configured: boolean}` — **presence
  only**; the token itself never appears in any response body. `503` while
  the DB is degraded.
- `PUT /api/v1/settings/hf-token` — `{hfToken: string | null}`: a non-empty
  string sets the hub-wide token, `null` clears it (settings row deleted);
  anything else → `400`. On success every online agent receives a
  `config-update` with the new value; offline agents get it in the
  config-update that follows their next hello. `503` while degraded.
- The token rides `config-update` frames only (never job params or
  job-output frames); the agent applies it as the modelctl child `HF_TOKEN`,
  and a hub-set token wins over the agent's `IRORI_HF_TOKEN` (bootstrap
  fallback). The token is always optional — unset, nothing is sent anywhere.

## Analytics (M7)

- `GET /api/v1/analytics/:lens?range=&groupBy=` — five lenses
  (`memory|decode|power|temps|tokens`), ranges `1h|24h|7d|30d|90d`,
  `groupBy=cluster|node` (cluster = a serving setup; nodes in no setup fold
  into a `standalone` group). Optional `setupId`/`nodeId` filters. Answers
  from the rollup buckets — never raw scans. Temps uses minute buckets for
  the 7d range (min/max pairs); every other combination uses hour/day.
- Aggregation semantics are per lens and physical: decode/tokens/power/memory
  add across members; temps aggregate fleet-max (max-of-max, min-of-min,
  mean-of-avg, any-throttled). Power points carry `baseW` and a `coverage`
  fraction; watts are clamped to the 240 W GB10 envelope and labeled
  estimated, not wall-metered.
- The tokens lens additionally returns `models[]` — per-model
  generated/prompt/cached totals over the range from the ledger. Ledger
  columns reflect only counters the backend actually published; an unpublished
  counter is NULL-coverage, never a zero.

## Disk hygiene (M7)

- `GET /api/v1/nodes/:id/cleanup` — `{latestAudit, history (last 20),
  prevention}`; `PUT /api/v1/nodes/:id/hygiene` — `{weeklySafePass: boolean}`.
- `hygiene-audit` / `hygiene-clean` / `hygiene-prevent` are agent-side jobs
  (one active per node, 409 otherwise). The agent's FINAL output line is the
  JSON report (validated against the core schemas) and lands in
  `cleanup_runs.report`; a clean's categories continue past a failing
  category (per-category `failed` outcome). The protected set — modelctl
  registrations, running-container images, `/proc` open files, files <24 h
  outside caches, the NAS store — is enforced agent-side; `modelctl-staging`
  cleans go through `modelctl cleanup-staging --apply`, never raw `rm`.
- `hygiene-prevent` writes docker `daemon.json` log rotation (backup kept)
  and records `logRotationApplied` in the node's prevention settings; docker
  is NOT restarted by the agent (it may live on that daemon).

## Nodes

- The agent token is returned **exactly once**: `POST /api/v1/nodes` →
  `{node, token}`, `POST /api/v1/nodes/:id/token/rotate` → `{token}` — registry
  payloads never carry it. The web NodeModal (IRI-010) is the UI surface for
  this contract: one-time reveal with the agent env block and the hub-served
  install block (IRI-011).
- `POST /api/v1/nodes` persists `llmPorts` (as `127.0.0.1` probe assignments)
  and `nasRoot` — a create with a NAS root yields a model-ops node, not a
  silently dropped field.
- `PATCH /api/v1/nodes/:id` accepts `llmPorts: number[]` per the core
  contract and coerces them to `{port, host: "127.0.0.1"}` assignments at the
  store boundary, so `config-update` keeps probing them. Only keys present in
  the request body are applied (absent `llmPorts` never wipes stored values).
- `PUT /api/v1/nodes/:id/llm-ports` (`{ports: number[]}`) remains the
  dedicated probe-assignment endpoint and hardcodes the probe host to
  `127.0.0.1`.

## Agent onboarding & updates (IRI-011/012, ADR-0007)

- `GET /install-agent.sh`, `GET /irori-agent.service`,
  `GET /agent/irori-agent.mjs` serve the repo copies of the installer, unit
  and bundle; `503 {error: "agent artifacts not available"}` when the server
  has none resolved (env `IRORI_AGENT_ARTIFACTS_DIR` in containers, monorepo
  layout in dev). No secrets are embedded — the token is supplied by the
  operator at run time. Work while degraded.
- `GET /api/v1/version` → `{version}` — the hub's own version, the drift
  reference for the UI badges and the update target.
- `POST /api/v1/nodes/:id/agent-update` dispatches an `agent-update` job
  (params `{expectedVersion: hubVersion}`) → `202 {job}`. Refusals: `400`
  malformed id, `404` unknown node, `409` when the agent predates
  `AGENT_UPDATE_MIN_VERSION` (it cannot self-update — use the install
  one-liner once), `409` while the node has an active job, a running bench or
  a starting/running/stopping setup (the restart kills everything the agent
  supervises), `409` when the agent is unreachable.
- The agent fetches the bundle from the hub (URL derived from its own
  `IRORI_SERVER_URL`), validates it with `node --check`, keeps the previous
  bundle as `.bak` and restarts. Pre-restart failures settle via the normal
  `job-done` path; the restart itself severs the socket, so success is
  settled **on the node's next hello** — reported version equal to
  `expectedVersion` flips the job to `succeeded`; a mismatch leaves it
  running (a blip-reconnecting old agent must not fail an in-flight update).
- `reapOffline` skips `agent-update` rows younger than 10 minutes and fails
  older ones with a `.bak`/journalctl rollback hint; the rule lives in the
  existing reaper loop, so it survives server restarts. No new tables.

## Jobs and benches

- `POST /api/v1/nodes/:id/jobs` and `POST /api/v1/bench/:type` return `409`
  when the node already has a queued/running job or a running bench. The
  invariant is enforced by partial unique indexes in Postgres, so concurrent
  requests get a deterministic `409` (not a race outcome); the second request
  never reaches the agent.
- Bench configs are parsed server-side and the `host` field is pinned to
  `127.0.0.1`: a bench always runs against the node-local engine, and a
  client-supplied host is ignored (the agent must never become a network
  probe). The stored `config` reflects the parsed, defaulted values.
- Terminal `job-done`/`bench-done` frames are durable: the agent replays them
  after a reconnect and the server retries the DB write through its bounded
  buffer, so the one-active slot is released even across a blip or server
  restart.
- The bench offline reaper never overwrites a terminal result with
  `failed: node went offline` (its update is status-guarded).

## Setups

- Setup frames (`setup-ack`, `setup-event`, `setup-log`) are accepted only
  from the setup's head node; `setup-validate-result` only from the node the
  validation was sent to. Frames from any other authenticated agent are
  ignored.
- Transfer recovery re-runs a stage that was persisted `running` when the
  server died — a resumed transfer never reports `succeeded` with a stage
  that never executed.
