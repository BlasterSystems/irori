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
| `IRORI_MODELCTL_PIN` | `0.21.2` | Minimum modelctl version the `modelctl-install` job enforces |
| `IRORI_MODELCTL_PATH` | `/root/.local/bin/modelctl` | Explicit modelctl binary |
| `IRORI_STATE_DIR` | `~/.local/state/irori-agent` | Persistent state: setup drivers, run logs, usage buffer |
| `IRORI_USAGE_FLUSH_MS` | `30000` | Usage-buffer upload interval (ADR-0008) |
| `IRORI_USAGE_MAX_ROWS` | `200000` | Usage-buffer hard cap (drop-oldest) |

## Web

No runtime configuration; built static assets are served by the server.
