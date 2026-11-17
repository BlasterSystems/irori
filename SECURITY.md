# Security Policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** (no email, no public issue):

https://github.com/BlasterSystems/irori/security/advisories/new

Do not open a public issue for a security problem.

## Scope

| Component | In scope |
|---|---|
| `apps/server` | the hub — Express API, static UI, agent WebSocket |
| `apps/agent` | the privileged node agent (root systemd service) |
| `apps/agent/install-agent.sh`, `apps/agent/irori-agent.service` | node installer |
| `docker/`, `deploy/` | container build & deployment |

Out of scope: your own homelab infrastructure (host OS, Docker, Postgres,
NAS) and [modelctl](https://github.com/piresbruno/modelctl) — report those
upstream.

## Trust model

Irori is a single-operator homelab tool (SPEC §2): **no application
authentication**. The hub and its agent WebSocket assume a trusted LAN, and
the agent runs as root by design (clock control, sysfs, modelctl paths).
Do not expose the hub port to the internet. Secrets at rest (node SSH
credentials, agent tokens) are AES-256-GCM encrypted under `ENCRYPTION_KEY`.

## Supported versions

Only the latest `v*` release tag and `main` receive security fixes.
