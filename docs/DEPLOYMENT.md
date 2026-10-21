# Deployment

## Dev CD (Proxmox docker VM) — INSTALLED & VERIFIED 2026-10-17

First real deploy: tag `dev-0.1.0-dev.2` → run 39080561043 **success**
(test gate on GitHub runners → deploy on `iroiri-dev-vm`) — container
`irori-dev` up on **10.0.10.9:3947**, `/healthz` ok, SPA served
(`IRORI_STATIC_DIR=/srv/irori-web`), `deploy/.env` preserved.

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
against a real Postgres service, validate, docs-check) on GitHub runners, then
deploys from the self-hosted runner on the runner VM (LXC 110):

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
install job enforces; default `0.21.2`), `IRORI_MODELCTL_PATH`, and
`IRORI_STATE_DIR` (default `~/.local/state/irori-agent`) — the state dir holds
setup-driver state (`setups.json`), persisted run logs (`setup-logs/`), and the
usage capture buffer (`usage-buffer.db`, M8/ADR-0008: `IRORI_USAGE_FLUSH_MS`
upload interval, default 30 s; `IRORI_USAGE_MAX_ROWS` buffer cap, default
200 000) — so give it a persistent volume when containerized.

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
GitHub reachability needed on the node. The Add-node modal shows this block
ready to copy:

```sh
curl -fLsS -o install-agent.sh http://IRORI_HOST:3947/install-agent.sh
curl -fLsS -o irori-agent.service http://IRORI_HOST:3947/irori-agent.service
sudo bash install-agent.sh --server ws://IRORI_HOST:3947/agent-ws --token irn_... --bundle-url http://IRORI_HOST:3947/agent/irori-agent.mjs
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
