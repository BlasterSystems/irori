# Deployment

## Dev CD (Proxmox docker VM) — INSTALLED & VERIFIED 2026-10-17

First real deploy: tag `dev-0.1.0-dev.2` → run 39080561043 **success**
(test gate on the self-hosted runner → deploy on `iroiri-dev-vm`) — container
`irori-dev` up on **10.0.10.9:3947**, `/healthz` ok, SPA served
(`IRORI_STATIC_DIR=/srv/irori-web`), `deploy/.env` preserved.

**2026-10-30: all jobs (test gate included) run on the self-hosted runner**
— GitHub-hosted build minutes are exhausted (billing), so `ubuntu-latest` was
replaced everywhere except `release.yml`. The Postgres service container was
replaced by a throwaway cluster: the runner VM (LXC 110) has `postgresql-17`
binaries installed (default cluster service disabled) and each job `initdb`s
a fresh cluster into a temp dir, points `IRORI_TEST_DATABASE_URL` at it, and
stops/deletes it in an `always()` step.

Topology (corrected): the **deploy VM is LXC 106 `docker` = 10.0.10.9**
(deploy user, docker 29.8.2); the **runner VM is LXC 110 `gh-runner` =
10.0.10.10** (all GH runners, user `ghrunner`). The self-hosted runner
`iroiri-dev-vm` is registered to this repo and runs from
`/opt/github-runner-iriori`. NOTE: the repo was renamed
`iriori` → **`irori`** on 2026-10-17 — registration/config URLs must use the
new name (old paths redirect).

Pipeline: `.github/workflows/cd-dev.yml` — trigger by pushing a `dev-*` tag
(convention `dev-<version>-<n>`, e.g. `dev-0.3.0-14` — next after
`dev-0.3.0-dev.13`; only the `dev-*` prefix is load-bearing, nothing parses
the rest, and historical tags keep their names) (or run manually with a ref).
It runs the full verify gate (typecheck, tests
against a throwaway Postgres cluster on the runner VM, validate, docs-check)
on the self-hosted runner (LXC 110), then
deploys from the same runner:

1. Test gate passes → runner creates a git bundle of the exact commit.
2. SSH (localhost from the runner VM to 10.0.10.9) → fetch bundle into
   `/opt/irori`, `checkout --detach`.
3. `docker compose -f deploy/docker-compose.yml build --pull irori`
   (server role of `docker/Dockerfile`), remembers the previous image ID. The
   deployed tag is baked in as the `GIT_TAG` build arg (`IRORI_GIT_TAG`) and
   shown in the UI footer (`Irori <version> · <tag>`); manual dispatches from
   a branch carry no tag.
4. Swap container `irori-dev` (port 3947, env from `deploy/.env`).
5. Health gate: 60 × 2 s against `http://127.0.0.1:3947/healthz` inside the
   container; on failure the previous image is retagged and restarted
   (auto-rollback).

Secrets/variables (repo `BlasterSystems/irori`, environment `development`):

| Name | Kind | Value |
|---|---|---|
| `DEV_VM_SSH_KEY` | secret | SSH private key accepted by the VM for `$DEV_VM_USER` (irori-dev-cd keypair) |
| `DEV_VM_HOST` | variable | `10.0.10.9` |
| `DEV_VM_USER` | variable | `deploy` |
| `DEV_DEPLOY_DIR` | variable | `/opt/irori` |

Database: PostgreSQL on the Proxmox pgsql server **10.0.10.136** (role/db
`irori_dev` for dev) — referenced from `deploy/.env` on the VM; nothing is
persisted on the VM itself. Boot migrations apply automatically and are
advisory-locked (ADR-0002).

### Ops notes

- Rollback: the previous image ID is saved to `/tmp/irori-dev.prev`; a failed
  health gate retags + restarts it automatically. Manual rollback:
  `docker tag <prev-id> irori-dev:latest && docker compose -f deploy/docker-compose.yml up -d --no-deps irori` (on 10.0.10.9).
- Runner service: `actions.runner.BlasterSystems-irori.iriori-dev-vm.service`
  on LXC 110. Re-register only with the CURRENT repo name (see rename note).
- Logs: `journalctl -u actions.runner.BlasterSystems-irori.iriori-dev-vm.service`
  (LXC 110); container logs: `docker logs irori-dev` (LXC 106).

## Agent

The agent is configured via env (no config file): `IRORI_SERVER_URL`,
`IRORI_NODE_TOKEN`, `IRORI_CADENCE_MS`, `IRORI_LLM_TARGETS`,
`IRORI_LLM_DETECT_ONLY`, `IRORI_MODELCTL_PIN` (minimum modelctl version the
install job enforces; default `0.24.0`, used when the hub pin is unset), `IRORI_MODELCTL_PATH`,
`IRORI_HF_TOKEN` (optional HF token passed to modelctl as `HF_TOKEN` for
gated/private repos; bootstrap fallback — a hub-set global token defined in
the UI wins and is pushed via config-update, IRI-019), and
`IRORI_STATE_DIR` (default `~/.local/state/irori-agent`) — the state dir holds
setup-driver state (`setups.json`), persisted run logs (`setup-logs/`), and the
usage capture buffer (`usage-buffer.db`, M8/ADR-0008: `IRORI_USAGE_FLUSH_MS`
upload interval, default 30 s; `IRORI_USAGE_MAX_ROWS` buffer cap, default
200 000) — so give it a persistent volume when containerized.

### OpenTelemetry export (IR-116/IR-117, IRI-039)

Both server and agent export traces and logs over OTLP when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (OTLP/HTTP; standard `OTEL_*` variables
apply, e.g. `OTEL_EXPORTER_OTLP_HEADERS`); unset, behavior and output are
exactly as before. `OTEL_SERVICE_NAME` overrides the default
(`irori-server` / `irori-agent`); `IRORI_LOG_LEVEL` (default `info`) sets the
pino level for both the stdout JSON lines and the OTLP log stream.

- **Traces:** one GenAI span per captured request from the agent's proxy
  (`gen_ai.usage.*`, `gen_ai.response.time_to_first_chunk`, finish reasons);
  client `traceparent`/`tracestate` ride the usage event and are forwarded
  verbatim, so with a context-propagating client and vLLM's
  `--otlp-traces-endpoint` the chain client → proxy → engine is one trace.
  The hub emits low-cardinality SERVER spans per request (`/healthz`
  skipped, UUID/numeric path segments normalized to `:id`).
- **Logs:** pino JSON to stdout, plus OTLP log records when the endpoint is
  set; providers flush on SIGTERM so restarts lose nothing.
- **No content**: prompts, responses, and bodies never appear in spans or log
  records (content stays in IR-52's opt-in body store, browsable via Chats).
- **Backend choice is deliberately open** (Jaeger all-in-one and Grafana
  Alloy both speak OTLP/HTTP on :4318) — point the env at whichever
  collector runs on the docker VM.

### Release artifacts (M7)

A `v*` tag triggers `.github/workflows/release.yml`: multi-arch (amd64+arm64)
images `ghcr.io/blastersystems/irori:<tag>` (server role) and
`ghcr.io/blastersystems/irori-agent:<tag>` (agent role) land on GHCR, and the
agent bundle, install script and systemd unit are attached to the GitHub
release. Tag only commits whose CI (`verify` + `docs-check`) is green, per
`docs/RELEASING.md` — the release workflow does not run tests.

Bare-metal agent install (as root on the agent host; the script completes only
when the WS hello lands in the journal). The installer needs no Node.js
preinstalled: it uses the host's node when it is 24+, otherwise it provisions
a pinned Node 24 into `/opt/irori/node` (sha256-verified from nodejs.org,
override with `IRORI_NODE_VERSION`) and pins the unit's `ExecStart` and `PATH`
to it. Preferred since IRI-011: everything comes from the hub itself — no
GitHub reachability needed on the node. The installer itself sets up only
Node, the bundle and the unit; the hub then provisions the rest within
moments of the first hello (IR-272): `uv`, modelctl at or above the hub pin
(the agent default `0.24.0` when no pin is set) for the node's model cache
user (or root on the NAS), that user's `~/.cache/huggingface/hub`, and
`rsync` on serving nodes. Setting or changing the model cache user later
does the same for the new user. The Add-node modal shows this block
ready to copy:

```sh
curl -fLsS -o install-agent.sh http://IRORI_HOST:3947/install-agent.sh
curl -fLsS -o irori-agent.service http://IRORI_HOST:3947/irori-agent.service
sudo bash install-agent.sh --server ws://IRORI_HOST:3947/agent-ws --token irn_... --bundle-url http://IRORI_HOST:3947/agent/irori-agent.mjs
```

Re-running the installer is how you fix a wrong `--server` or `--token`: it
rewrites `/etc/irori/agent.env` and **restarts** the unit (IRI-156; before,
`enable --now` left an already-running agent on its old config). It runs a
warn-only WebSocket preflight against `--server` first, only counts a
`handshake ok` logged after the restart (journal cursor taken just before it),
and on timeout prints the agent's last `connection error` / `server error`
lines. The restart interrupts jobs running on that node (downloads,
transfers), so re-run on an idle node.

#### Store mount on Sparks (IRI-173)

A Spark that syncs from the NAS store must see the store's `active/` entries
as **symlinks**. modelctl on the NAS node writes ordinary symlinks on the
QNAP volume, and `sync-local` refuses anything else. Check on the Spark:

```sh
stat -c %F /mnt/nas/active/<model-name>   # must print: symbolic link
```

- **SMB/CIFS** (the `mfsymlinks` mount from the M4 runbook) shows those
  server-side symlinks as directories, so every sync from the store fails
  there. `mfsymlinks` only covers links created through a client mount.
- **NFS** passes symlinks through unchanged and is the expected fix: export
  the QNAP `LLMs` share read-only to the Sparks and mount it at the node's
  NAS root. Not verified on the fleet yet (2026-11-28: the QNAP exported
  only `/Proxmox`); replace this note with the fstab line once it is.

Irori reports what each node sees (node page warning, `store.unlinkedActive`
in the inventory), does not offer a NAS sync to a node that cannot see the
link, and fails `sync-local` with a plain message before modelctl starts.

#### Behind a TLS reverse proxy (IRI-156)

The dev hub is also published as `https://irori.as267.com` through Nginx Proxy
Manager (LXC 104) → `http://10.0.10.9:3947`. Two things must hold:

- **Agents dial `wss://`**, e.g. `--server wss://irori.as267.com/agent-ws`.
  Plain `ws://` hits the proxy's 301 to https, and WebSocket clients do not
  follow redirects (`connection error: Unexpected server response: 301`). The
  Add-node modal derives the scheme from the page, so opened over https it
  already shows `wss://`.
- **The proxy forwards WebSocket upgrades** for `/agent-ws`: NPM's "Websockets
  Support" toggle, or in raw nginx `proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`
  plus a long `proxy_read_timeout`. Without it the request reaches Express as
  plain HTTP and the agent sees `Unexpected server response: 404`.

Quick check from any host: a `101 Switching Protocols` means the path is good.

```sh
curl --http1.1 -sS -o /dev/null -w '%{http_code}\n' --max-time 3 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: aXJvcmktcHJlZmxpZ2h0IQ==' https://irori.as267.com/agent-ws
```

GitHub release artifacts remain the fallback (`--bundle-url` may be omitted to
pull the bundle from GitHub):

```sh
curl -fLsS -o install-agent.sh https://github.com/BlasterSystems/irori/releases/latest/download/install-agent.sh
chmod +x install-agent.sh
./install-agent.sh --server ws://IRORI_HOST:3947/agent-ws --token irn_... --version v0.2.0
```

### Updating agents (IRI-012, ADR-0007)

For any agent ≥ 0.3.0 that is online, updates are one click on the node
drill-down ("Update agent → <hub version>"): the hub dispatches an
`agent-update` job over the existing WS link, the agent fetches the hub's own
bundle, validates it (`node --check`), keeps the old one as
`/opt/irori/irori-agent.mjs.bak` and restarts. No credentials are requested
or stored; the token/env/unit are never rewritten. The job settles from the
node's first hello after the restart (or fails after a 10-minute grace with a
rollback hint in the job output). Restarting the agent stops its running
setups and benches — the dispatch refuses while either is active.

Agents older than 0.3.0 cannot self-update: run the install one-liner once
(same token — it only replaces the bundle), then update from the UI.
Containerized agents upgrade by pulling the new tag and re-creating the
container (unchanged). Note: the agent image ships node-slim +
rsync/curl/openssh but no docker CLI, so disk-hygiene docker categories
report "docker CLI not available" unless the CLI + socket are added to the
container; bare-metal agents (the primary install, SPEC §11) have docker.

Serving setups (M5) spawn the start/stop script pair from the agent process:
a containerized agent on a node whose scripts manage host services (e.g.
`docker start …` over `/var/run/docker.sock`) needs that socket bind-mounted
into the agent container; bare-metal agents need no extra mounts. Scripts are
validated with `test -x` inside the agent's own mount namespace.

## Production

Not yet (v1 scope is dev CD; PROD follows the same pattern with an
`irori-prd-vm` runner and environment — see IR-10 epic).

## Signal runbook (IR-200)

What to check when a health signal fires. The Overview banner copies these
strings (IR-205: banner hint text matches this runbook).

### Database unavailable (`db_unavailable`, fleet)

Degraded routes keep answering: `/healthz` reports `db: false`, routes that
need the DB return 503, and the live rings keep the running views alive
(ADR-0002) — hub data on the page may be stale until the database returns.
Check the pg host (the Proxmox pgsql VM): `systemctl status postgresql`, disk
and memory (`df -h`, `free -m`), then reachability from the deploy VM
(`pg_isready -h <pg-host> -p 5432` against the hub's `DATABASE_URL`). Recovery
is automatic: the rule clears on the first healthy sweep.

### Hub disk pressure (`hub_disk_pct`, fleet)

Check the hub VM filesystem — docker build cache is the usual culprit
(`docker system df` on the deploy host): `docker builder prune` for build
cache, then `docker image prune -a` only after confirming nothing running
uses those images. The gauge measures the filesystem backing `HUB_DISK_PATH`
(default `/` — the container root in the deployed container; see
CONFIGURATION.md).

### Node disk pressure (`disk_pct`, per node)

The banner row deep-links to the node; **Clean up disk — est. +N GB** opens
the per-node cleanup drawer (hygiene audit categories, dry-run plan first,
nothing deleted without a typed confirm). If no est. shows, run an audit
there first — the estimate comes from the node's last audit (cached ~5 min).

### Telemetry gap (`telemetry_gap_s`, per node)

Snapshots stopped arriving. Check the agent on the node: `systemctl status
irori-agent`, `journalctl -u irori-agent -n 50`. Since IR-206 a wedged network
mount no longer stalls the agent (bounded statfs, async NAS reads) — a gap
with the agent alive and answering clocks points at the network path, not a
hung statfs. A wedged CIFS mount still reports capacity if healthy; the
snapshot skips it after the 2 s bound when it is not.

