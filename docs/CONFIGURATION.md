# Configuration

Where each component's configuration lives. Details and deployment context:
[DEPLOYMENT.md](DEPLOYMENT.md).

## Server

Env only (`loadConfig`); defaults as listed. `ENCRYPTION_KEY` is required
whenever `DATABASE_URL` is set (ADR-0002):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | none (boots degraded) | PostgreSQL connection string (ADR-0002) |
| `ENCRYPTION_KEY` | required with `DATABASE_URL` | AES-256-GCM key for stored credentials/tokens (ADR-0002) |
| `PORT` | `3947` | HTTP listen port |
| `SNAPSHOT_RETENTION_HOURS` | `24` | DB snapshot pruning age (ADR-0006) |
| `MINUTE_KEEP_DAYS` | `7` | Minute-bucket retention |
| `HOUR_KEEP_DAYS` | `90` | Hour-bucket retention |
| `DAY_KEEP_DAYS` | `365` | Day-bucket retention |
| `AUDIT_KEEP_DAYS` | `365` | Durable audit-log retention (IRI-077); the event journal keeps a fixed 90 d |
| `LOG_KEEP_DAYS` | `30` | Durable log retention for rows below `warn` (IRI-078) |
| `LOG_WARN_KEEP_DAYS` | `180` | Durable log retention for `warn`+ rows (IRI-078) |
| `CADENCE_MS` | `2000` | Snapshot cadence handed to agents (bounded 1–60 s); the persisted hub setting (hub settings modal) overrides it and is live-pushed via config-update |
| `HUB_DISK_PATH` | `/` | Filesystem the hub disk gauge watches for the `hub_disk_pct` health rule (IR-201); in the deployed container this is the container root. The gauge runs once per 30 s sweep, never per request |
| `IRORI_STATIC_DIR` | `apps/web/dist` | Served web assets |
| `IRORI_AGENT_ARTIFACTS_DIR` | bundled | Served agent installer/unit/bundle (ADR-0007) |
| `IRORI_GIT_TAG` | none | Deployed git tag surfaced in the version footer |

## Agent

The agent is configured via env only (`loadConfig`, no config file). All
variables are optional unless noted:

| Variable | Default | Purpose |
|---|---|---|
| `IRORI_SERVER_URL` | `ws://127.0.0.1:3947/agent-ws` | Hub WebSocket endpoint |
| `IRORI_NODE_TOKEN` | required | Per-node hello token (refuses to start without it) |
| `IRORI_CADENCE_MS` | `2000` | Snapshot cadence (server may override) |
| `IRORI_LLM_TARGETS` | none | `host:port,...` probe targets extending/overriding server-assigned ports |
| `IRORI_LLM_DETECT_ONLY` | off | Force detection-only LLM probes (no rates) |
| `IRORI_MODELCTL_PIN` | `0.23.0` | Fallback minimum modelctl version for the `modelctl-install` job; the hub's `modelctl_pin` setting (IR-105) overrides it via config-update and drives per-user auto-provisioning |
| `IRORI_MODELCTL_PATH` | `/root/.local/bin/modelctl` | Explicit modelctl binary |
| `IRORI_STATE_DIR` | `~/.local/state/irori-agent` | Persistent state: setup drivers, run logs, usage buffer |
| `IRORI_MIN_STORE_FREE_BYTES` | `1649267441664` (1.5 TiB) | Download floor (IR-213, IR-207): the job-start gate fails `download`/`download-queue` jobs when the store volume's free space (agent telemetry, snapshot-fresh) is below this, and the same value rides `--min-free-bytes` into modelctl so the per-file check covers the whole expected download; `0` disables both. The per-file check belongs to modelctl's download path — the gate protects the job boundary |
| `IRORI_USAGE_FLUSH_MS` | `30000` | Usage-buffer upload interval (ADR-0008) |
| `IRORI_LOG_FLUSH_MS` | `2000` | Durable log-buffer ship interval (IRI-078) |
| `IRORI_LOG_QUEUE_MAX` | `10000` | In-memory log queue cap before drop-oldest (IRI-078; buffer keeps 50k rows on disk) |
| `IRORI_USAGE_MAX_ROWS` | `200000` | Usage-buffer hard cap (drop-oldest) |
| `IRORI_HF_TOKEN` | none | Optional HF token handed to modelctl as `HF_TOKEN` (IRI-017) — enables gated/private repo downloads; never sent to the hub or stored in job params. Bootstrap fallback: a hub-set global token (IRI-019) wins over this env |

The per-node model inventory (IRI-028) needs no new env: the agent lists its
own cache via `IRORI_MODELCTL_PATH` and discovers every other user's cache
under `/home/*` + `/root` (requiring `<home>/.cache/huggingface` and an
executable `<home>/.local/bin/modelctl`), running `modelctl list --local` as
that user. Nodes whose agents predate the `models-inventory` job kind answer
its refresh with a visible failure until they are updated.

## Web

No runtime configuration; built static assets are served by the server.

### Usage capture matching (IRI-055)

The capture proxy records `POST` requests whose path is one of
`chat/completions`, `completions`, `embeddings`, `responses` — with or
without the `/v1/` prefix. Engines that serve both spellings (TensorFold
does) are therefore captured regardless of whether the client's provider
baseUrl includes `/v1`; the stored `endpoint` is always canonicalized to the
`/v1/` spelling. No configuration is involved — nothing to set.

### Hub settings (runtime, IRI-019)

The global HF token is defined in the UI (footer gear → Hub settings) or via
`PUT /api/v1/settings/hf-token` (`{ "hfToken": "hf_…" }` sets, `null`
clears). It lives in the `settings` table, is pushed to online agents via
`config-update` (offline agents pick it up on their next hello), and always
wins over the agent's `IRORI_HF_TOKEN`. `GET /api/v1/settings/hf-token` is
presence-only — the token itself never appears in a response body. The token
is always optional; when unset, modelctl runs without `HF_TOKEN` and the
quants listing sends no Authorization header.
