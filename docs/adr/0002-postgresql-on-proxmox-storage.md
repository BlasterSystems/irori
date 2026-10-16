# ADR-0002: PostgreSQL storage on the Proxmox server, encrypted secrets, no application auth

- **Status:** Proposed
- **Date:** 2026-10-16
- **Decision owners:** piresbruno
- **Scope:** Persistence engine, schema tooling, retention, secrets at rest, auth posture
- **Tags:** storage, postgres, drizzle, encryption, security, homelab, proxmox
- **Supersedes:** None
- **Superseded by:** None

## Context

Irori is a homelab, single-operator tool. The server container may run on any
LAN computer; nodes, snapshots, rollups, models, recipes, jobs, benchmarks, and
analytics buckets must persist. There is **no auth or user management**
(requirement), but SSH credentials and per-node agent tokens must be stored
safely. The homelab already operates a **PostgreSQL server on the Proxmox
host**, and the owner prefers reusing it over adding another stateful store.
The source projects scattered state across JSON config files (`sparks.json`,
`spark-clocks.json`, `traces.sqlite`, modelctl journals); unifying on one
schema-aware store removes that drift.

## Decision drivers

- Reuse existing infrastructure; avoid a second database instance to back up.
- Telemetry is high-write (snapshots every ~2 s, agent-hub bursts, rollup jobs)
  and read from several writers — concurrent-write friendly engine.
- Pure-JS driver keeps the server image free of native modules (drops the
  musl/arm64 native-build risk entirely).
- Secrets at rest are a hard requirement even without app auth.
- Schema evolves per milestone; migrations must be reviewable.

## Considered options

### Option 1: PostgreSQL on the existing Proxmox server (chosen)

Connection via `DATABASE_URL` (postgres.js driver, Drizzle). `drizzle-kit`
migrations applied on boot under an advisory lock. Retention via prune job +
rollup tables. Secrets encrypted AES-256-GCM under `ENCRYPTION_KEY` in a
dedicated table — encryption stays application-level because the DB lives on
another host. Resilience: in-memory rings serve the live view while the
connection is down; ingest buffers (bounded) and reconnects with backoff.

### Option 2: Embedded SQLite (WAL) + Drizzle

Zero network dependencies and one-file backup, but adds a second stateful
store to operate and back up, uses a native module (better-sqlite3) with the
musl/arm64 prebuild burden, and serializes writers at busy-timeouts. Rejected:
the owner runs Postgres infrastructure already; reuse wins at equal technical
adequacy.

### Option 3: JSON/config files per concern (status quo of source projects)

No migrations, no typed queries, drift between four projects' formats.

## Decision

Option 1. PostgreSQL (16+) on the Proxmox pgsql server is the only store,
accessed exclusively via `DATABASE_URL`. No application authentication
(homelab trust model, SPEC §12): the API is protected by network position,
documented as such; SSH credentials and agent tokens are the only secrets and
are AES-256-GCM encrypted, never returned by the API. Rollups and retention
policy are unchanged by the engine choice (ADR-0006).

## Consequences

### Positive

- Reuses operated infrastructure; one less stateful service to run.
- Native-module-free server image; concurrent writers without lock tuning.
- pg_dump-based backups and point-in-time recovery if configured.

### Negative

- New network dependency: the server is degraded while Proxmox/DB is
  unreachable (mitigated below).
- `ENCRYPTION_KEY` and DB credential management are on the user (documented
  rotation).

### Risks and mitigations

- DB outage → in-memory per-node rings keep the live view and collection
  unaffected; bounded ingest buffer + reconnect/backoff; API surfaces
  degraded state instead of failing writes.
- Shared pgsql server under other workloads → dedicated database + role for
  iroiri; connection pool sized; rollups keep analytical load off raw tables.

## Implementation and validation

M1: `packages/db` with nodes/snapshots/settings/secrets; migration-on-boot
(idempotent, advisory-locked) + connection-retry tests; CI runs an ephemeral
Postgres service container. Validation: `pnpm test`; kill-and-restart smoke
against a real Proxmox DB; M2 exercises ingest bursts + prune.

## Revisit triggers

- The Proxmox pgsql server is decommissioned or repurposed → new ADR for an
  embedded fallback.
- DB round-trips measurably degrade snapshot ingest (unlikely at homelab
  scale) → batch/coalesce writes before reconsidering the engine.

## References

- SPEC §4, §12, §14; PLAN M1/M2; ADR-0001 (stack), ADR-0003 (agent tokens),
  ADR-0006 (retention/rollups).
- Rejected-option precedent: `uptime-monitoring/docs/adr/0002-sqlite-first-storage-secrets-encryption.md`.
