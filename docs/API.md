# API behavioral contract

Endpoint inventory lives in `SPEC.md` §6; this file records the behavioral
guarantees callers rely on, kept current when behavior changes. Last updated
by the M7 batch (adversarial-review fixes + analytics/hygiene).

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
