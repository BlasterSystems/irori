# Architecture

## Purpose

This document is the current high-level map of **irori**. Keep it concise. Detailed historical rationale belongs in `docs/adr/`.

## System Context

- **Operator:** a single homelab owner; no application auth (trust boundary = the LAN).
- **Managed fleet:** NVIDIA DGX Spark (GB10) units in head/worker/standalone roles, discrete-GPU Linux hosts, and one NAS node that owns the `modelctl` model store.
- **External systems:** `modelctl` CLI (store engine, subprocess), Hugging Face Hub (downloads), inference engines (vLLM, llama.cpp, SGLang, …) probed read-only, LLM engines' Prometheus `/metrics` where published.
- **Trust boundaries:** the agent runs as root on nodes and connects **out** to the server with a per-node token; the server holds SSH credentials (AES-256-GCM) used only for bootstrap/fallback.

## Components

| Component | Responsibility |
|---|---|
| `apps/server` | Express 5: REST `/api/v1`, SSE hub `/api/v1/events`, agent WS hub `/agent-ws`, job runner, static SPA, settings |
| `apps/web` | Vue 3 + Vite SPA; BlasterSystems DS token port, brand lockup, Overview/Node/Models/Serve/Benchmarks/Analytics views, node management modal (add/edit/rotate/delete, IRI-010) |
| `apps/agent` | Node daemon (esbuild bundle): collectors, LLM probes, clock control, modelctl job execution, serving supervision; root systemd unit |
| `packages/core` | Cross-process contracts: snapshot/job/serving schemas (zod), store-layout constants, catalog reader, placement planner |
| `packages/db` | Drizzle schema + migrations (PostgreSQL on the Proxmox pgsql server): nodes, snapshots, rollups, models, recipes, runs, jobs, benchmarks, token/energy ledgers, secrets |

## Data and State

- Authoritative store: **PostgreSQL on the Proxmox pgsql server** (`DATABASE_URL`), schema via Drizzle, migrations applied on boot under an advisory lock pinned to a reserved connection. Bounded raw snapshot ring + minute/hour/day rollups + prune job (ADR-0002, ADR-0006). The server degrades gracefully (in-memory rings, bounded ingest buffer) while the DB is unreachable; terminal job/bench frames ride the same drop-oldest buffer and are retried until the write lands.
- One active job/bench per node is enforced by partial unique indexes (`jobs_node_active_uq`, `bench_runs_node_running_uq`) — the 409 busy error survives concurrent requests, not just the check-then-insert fast path.
- **Usage capture (M8, ADR-0008):** flagged setups route engine traffic through an in-agent capture proxy (`packages/proxy`, raw byte pipe + passive tee). Captured requests buffer in node-local SQLite (WAL, expendable, 90 d/capped) and sync to Postgres `llm_requests` in acked ≤500-event batches — deduplicated by client UUID, so redelivery after a WS outage or crash is a no-op. Hourly/daily `usage_buckets` (per node + model) key on **server ingest time** and retain 1 y; raw rows 90 d. Every captured request fans out as an SSE `usage` event after the durable insert.
- **M7 analytics state**: the token ledger (`token_ledger`) diffs the probes' cumulative token counters per (node, port, model) into hourly/daily deltas (reset-safe; coverage columns, never guessed zeros); the monthly energy archive (`energy_monthly`) integrates clamped estimated watts from hour buckets; disk-hygiene runs persist to `cleanup_runs` (last 20 / 90 d). All three advance on watermark/idempotent-upsert patterns and never raw-scan the raw tables.
- **Per-node model inventory (IRI-028):** `node_inventory` caches the agent's read-only `models-inventory` report (store active models + failed-delete leftovers + per-user local HF-cache registrations — modelctl local state is per user, so a root agent lists each cache owner via `runuser`). Written from the job's final JSON line on success and deleted whenever a model-mutating job settles; the store itself stays modelctl-owned (ADR-0004), and `nas-delete-apply` preflights every object/staging directory with a create+unlink before `--apply` so a denied tree cannot orphan a deactivated model.
- The NAS store is **external state owned by modelctl** (ADR-0004); Irori reads `catalog.json` and mutates only through modelctl commands.
- Secrets table: SSH credentials + agent tokens encrypted AES-256-GCM under `ENCRYPTION_KEY`.
- Desired clock state per node; re-applied on node online transitions (ADR-0003).

## Integrations

- **Agent link:** outbound WS `/agent-ws`, token auth, resume cursor, `config-update` for rotation; SSH bootstrap/fallback with identical snapshot shapes. Agent-supplied `jobId`/`setupId` frames are scoped to the authenticated sending node; setup events/logs/acks are accepted only from the setup's head. A half-open socket's late `close` cannot deregister a reconnected node, and pings unanswered for two intervals terminate the connection. Agent self-updates ride the same channel (`agent-update` job, ADR-0007): the agent runs a `systemd-run` transient unit that replaces its bundle and restarts the unit; settlement is hello-driven and no credentials are involved.
- **Browser link:** SSE `/api/v1/events` (snapshot, run-log, job, bench, thermal events) with `/api/v1/events/recent` feed history for freshly loaded pages (IRI-013); REST for actions. Jobs are first-class telemetry (IRI-028): the hub emits a `job` frame with `status: "running"` on dispatch and a throttled `job-progress` frame (≤1/s per job, excluded from the feed ring) that drive the global Activity drawer, seeded by `GET /api/v1/jobs?limit=`.
- **modelctl:** subprocess with pinned minimum version (release tag + version gate); streamed job output; dry-run → armed applies for destructive ops.

## Deployment and Operations

- One Dockerfile, two role stages (`server`, `agent`) — separate role images, no argv dispatching; compose happy path for the server on any LAN computer; the agent's primary install is bare-metal (bundle + root systemd unit via install script, UI-assisted over SSH). The CD rollback captures the previous image id *before* the build retags `irori-dev:latest`.
- Validation gates: `pnpm test`, `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check`; CI builds amd64 + arm64 (M7).

## Agent-Guided Maintenance Boundary

When the agent-guided bootstrap workflow is used, repository evidence and agent proposals are untrusted. The deterministic core owns rendering, planning, apply, rollback, and validation. The agent stops after preview; a human separately confirms the recomputed plan in an interactive terminal. See `docs/AGENT_GUIDED.md`.

## Architecture Decision Index

Read `docs/adr/README.md` before individual decision records. Update this overview when an accepted ADR changes the current architecture.
