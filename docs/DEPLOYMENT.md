# Deployment

## Dev CD (Proxmox docker VM) — INSTALLED & VERIFIED 2026-10-17

First real deploy: tag `dev-0.1.0-dev.2` → run 39080561043 **success**
(test gate on GitHub runners → deploy on `iroiri-dev-vm`) — container
`irori-dev` up on **10.20.30.9:3947**, `/healthz` ok, SPA served
(`IRORI_STATIC_DIR=/srv/irori-web`), `deploy/.env` preserved.

Topology (corrected): the **deploy VM is LXC 106 `docker` = 10.20.30.9**
(deploy user, docker 29.8.2); the **runner VM is LXC 110 `gh-runner` =
10.20.30.10** (all GH runners, user `ghrunner`). The self-hosted runner
`iroiri-dev-vm` is registered to this repo and runs from
`/opt/github-runner-iriori`. NOTE: the repo was renamed
`iriori` → **`irori`** on 2026-10-17 — registration/config URLs must use the
new name (old paths redirect).

Pipeline: `.github/workflows/cd-dev.yml` — trigger by pushing a `dev-*` tag
(or run manually with a ref). It runs the full verify gate (typecheck, tests
against a real Postgres service, validate, docs-check) on GitHub runners, then
deploys from the self-hosted runner on the runner VM (LXC 110):

1. Test gate passes → runner creates a git bundle of the exact commit.
2. SSH (localhost from the runner VM to 10.20.30.9) → fetch bundle into
   `/opt/irori`, `checkout --detach`.
3. `docker compose -f deploy/docker-compose.yml build --pull irori`
   (server role of `docker/Dockerfile`), remembers the previous image ID.
4. Swap container `irori-dev` (port 3947, env from `deploy/.env`).
5. Health gate: 60 × 2 s against `http://127.0.0.1:3947/healthz` inside the
   container; on failure the previous image is retagged and restarted
   (auto-rollback).

Secrets/variables (repo `BlasterSystems/irori`, environment `development`):

| Name | Kind | Value |
|---|---|---|
| `DEV_VM_SSH_KEY` | secret | SSH private key accepted by the VM for `$DEV_VM_USER` (irori-dev-cd keypair) |
| `DEV_VM_HOST` | variable | `10.20.30.9` |
| `DEV_VM_USER` | variable | `deploy` |
| `DEV_DEPLOY_DIR` | variable | `/opt/irori` |

Database: PostgreSQL on the Proxmox pgsql server **10.20.30.136** (role/db
`irori_dev` for dev) — referenced from `deploy/.env` on the VM; nothing is
persisted on the VM itself. Boot migrations apply automatically and are
advisory-locked (ADR-0002).

### Ops notes

- Rollback: the previous image ID is saved to `/tmp/irori-dev.prev`; a failed
  health gate retags + restarts it automatically. Manual rollback:
  `docker tag <prev-id> irori-dev:latest && docker compose -f deploy/docker-compose.yml up -d --no-deps irori` (on 10.20.30.9).
- Runner service: `actions.runner.BlasterSystems-irori.iriori-dev-vm.service`
  on LXC 110. Re-register only with the CURRENT repo name (see rename note).
- Logs: `journalctl -u actions.runner.BlasterSystems-irori.iriori-dev-vm.service`
  (LXC 110); container logs: `docker logs irori-dev` (LXC 106).

## Agent

The agent is configured via env (no config file): `IRORI_SERVER_URL`,
`IRORI_NODE_TOKEN`, `IRORI_CADENCE_MS`, `IRORI_LLM_TARGETS`,
`IRORI_LLM_DETECT_ONLY`, `IRORI_MODELCTL_PIN`, `IRORI_MODELCTL_PATH`, and
`IRORI_STATE_DIR` (default `~/.local/state/irori-agent`) — the state dir holds
setup-driver state (`setups.json`) and persisted run logs (`setup-logs/`),
so give it a persistent volume when containerized.

Serving setups (M5) spawn the start/stop script pair from the agent process:
a containerized agent on a node whose scripts manage host services (e.g.
`docker start …` over `/var/run/docker.sock`) needs that socket bind-mounted
into the agent container; bare-metal agents need no extra mounts. Scripts are
validated with `test -x` inside the agent's own mount namespace.

## Production

Not yet (v1 scope is dev CD; PROD follows the same pattern with an
`irori-prd-vm` runner and environment — see IR-10 epic).
