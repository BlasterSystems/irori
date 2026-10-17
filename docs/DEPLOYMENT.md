# Deployment

## Dev CD (Proxmox docker VM)

Pipeline: `.github/workflows/cd-dev.yml` — trigger by pushing a `dev-*` tag
(or run manually with a ref). It runs the full verify gate (typecheck, tests
against a real Postgres service, validate, docs-check) on GitHub runners, then
deploys from the self-hosted runner on the dev docker VM (LXC 110):

1. Test gate passes → runner creates a git bundle of the exact commit.
2. SSH (localhost) → fetch bundle into `/opt/irori`, `checkout --detach`.
3. `docker compose -f deploy/docker-compose.yml build --pull irori`
   (server role of `docker/Dockerfile`), remembers the previous image ID.
4. Swap container `irori-dev` (port 3947, env from `deploy/.env`).
5. Health gate: 60 × 2 s against `http://127.0.0.1:3947/healthz` inside the
   container; on failure the previous image is retagged and restarted
   (auto-rollback).

Secrets/variables (repo `BlasterSystems/iriori`, environment `development`):

| Name | Kind | Value |
|---|---|---|
| `DEV_VM_SSH_KEY` | secret | SSH private key accepted by the VM for `$DEV_VM_USER` |
| `DEV_VM_HOST` | variable | `10.20.30.9` |
| `DEV_VM_USER` | variable | VM user that may run docker + write `/opt/irori` |
| `DEV_DEPLOY_DIR` | variable | `/opt/irori` |

Database: PostgreSQL on the Proxmox pgsql server **10.20.30.136** (role/db
`irori_dev` for dev) — referenced from `deploy/.env` on the VM; nothing is
persisted on the VM itself. Boot migrations apply automatically and are
advisory-locked (ADR-0002).

### One-time VM setup (IR-11 runbook)

On the VM (LXC 110) as root, with the deploy user's docker access:

```bash
# 1. Deploy dir + env (git clean -e keeps this file across deploys)
mkdir -p /opt/irori
cp deploy/.env.example /opt/irori/deploy/.env   # after first fetch; or create now
#    → set DATABASE_URL=postgres://irori_dev:<pw>@10.20.30.136:5432/irori_dev
#    → set ENCRYPTION_KEY=$(openssl rand -hex 32)

# 2. Runner (repo-scoped, label must be exactly: iroiri-dev-vm)
gh api repos/BlasterSystems/iriori/actions/runners/registration-token --jq .token
mkdir -p /opt/actions-runner-iriori && cd /opt/actions-runner-iriori
curl -o runner.tgz -L https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64-2.329.0.tar.gz
tar xzf runner.tgz
./config.sh --url https://github.com/BlasterSystems/iriori \
  --token <TOKEN> --labels iroiri-dev-vm --unattended --replace
./svc.sh install && ./svc.sh start   # or run under the deploy user + docker group
```

GitHub side:

```bash
gh secret set DEV_VM_SSH_KEY --repo BlasterSystems/iriori < /path/to/vm_key
gh variable set DEV_VM_USER --repo BlasterSystems/iriori --body <vm-user>
gh variable set DEV_VM_HOST --repo BlasterSystems/iriori --body 10.20.30.9
gh variable set DEV_DEPLOY_DIR --repo BlasterSystems/iriori --body /opt/irori
```

First deploy: `git tag dev-0.1.0-dev.1 && git push origin dev-0.1.0-dev.1`.

## Production

Not yet (v1 scope is dev CD; PROD follows the same pattern with an
`irori-prd-vm` runner and environment — see IR-10 epic).
