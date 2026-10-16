# ADR-0002: SQLite-first storage, encrypted secrets, no application auth

- **Status:** Proposed
- **Date:** 2026-10-16
- **Decision owners:** piresbruno
- **Scope:** Persistence engine, schema tooling, retention, secrets at rest, auth posture
- **Tags:** storage, sqlite, drizzle, encryption, security, homelab
- **Supersedes:** None
- **Superseded by:** None

## Context

Irori is a homelab, single-operator tool. The server container may run on any
LAN computer; nodes, snapshots, rollups, models, recipes, jobs, benchmarks, and
analytics buckets must persist. There is **no auth or user management**
(requirement), but SSH credentials and per-node agent tokens must be stored
safely. The source projects scattered state across JSON config files
(`sparks.json`, `spark-clocks.json`, `traces.sqlite`, modelctl journals);
unifying on one schema-aware store removes that drift.

## Decision drivers

- Zero external dependencies in `docker compose up` (NAS-grade hardware).
- Telemetry is high-write (snapshots every ~2 s, rollups) — needs WAL.
- Secrets at rest are a hard requirement even without app auth.
- Schema evolves per milestone; migrations must be reviewable.

## Considered options

### Option 1: SQLite (WAL) + Drizzle ORM (chosen)

Single file `/data/irori.db` (WAL, foreign_keys, busy_timeout). Drizzle gives
typed schema + SQL migrations; better-sqlite3 driver pinned for musl/arm64
prebuilds. Retention via prune job + rollup tables. Secrets encrypted
AES-256-GCM under `ENCRYPTION_KEY` in a dedicated table.

### Option 2: Postgres default

Stronger concurrency, but an external service contradicts goal 2 (one
container), and snapshot volumes are well within SQLite WAL capability at
homelab scale (≤ ~10 nodes).

### Option 3: JSON/config files per concern (status quo of source projects)

No migrations, no typed queries, drift between four projects' formats.

## Decision

Option 1. SQLite (WAL) via Drizzle is the only store. No application
authentication (homelab trust model, SPEC §12): the API is protected by network
position, documented as such; SSH credentials and agent tokens are the only
secrets and are AES-256-GCM encrypted, never returned by the API. Postgres is
out of scope for v1; the Drizzle schema keeps dialect-specific parts isolated
so a switch remains possible (not planned).

## Consequences

### Positive

- One-command deploy; typed schema; per-milestone incremental migrations.
- Consistent retention story (rings + rollups + prune job) for all telemetry.

### Negative

- Single-writer database: heavy analytical queries must hit rollups, not raw
  snapshots (SPEC §4, §9).
- `ENCRYPTION_KEY` management is on the user (documented key rotation).

### Risks and mitigations

- Corruption on power loss → WAL + documented backup (file snapshot of
  `/data`); busy_timeout for the agent-hub write bursts.

## Implementation and validation

M1: `packages/db` with nodes/snapshots/settings + migration test on `:memory:`;
secrets table in M1 (agent tokens) and SSH credentials at first use; prune job
in M2. Validation: `pnpm test` repo tests; manual kill -9 restart smoke.

## Revisit triggers

- Multi-user/remote-exposure requirement appears (auth ADR would follow).
- Snapshot write volume degrades the event loop beyond thresholds.

## References

- SPEC §4, §12, §14; PLAN M1/M2; ADR-0001 (stack), ADR-0003 (agent tokens).
- `uptime-monitoring/docs/adr/0002-sqlite-first-storage-secrets-encryption.md`.
