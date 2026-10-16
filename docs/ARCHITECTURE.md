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
| `apps/web` | Vue 3 + Vite SPA; BlasterSystems DS token port, brand lockup, Overview/Node/Models/Serve/Benchmarks/Analytics views |
| `apps/agent` | Node daemon (esbuild bundle): collectors, LLM probes, clock control, modelctl job execution, serving supervision; root systemd unit |
| `packages/core` | Cross-process contracts: snapshot/job/serving schemas (zod), store-layout constants, catalog reader, placement planner |
| `packages/db` | Drizzle schema + migrations (SQLite WAL): nodes, snapshots, rollups, models, recipes, runs, jobs, benchmarks, token/energy ledgers, secrets |

## Data and State

- Authoritative store: SQLite at `/data/irori.db` (WAL). Bounded raw snapshot ring + minute/hour/day rollups + prune job (ADR-0006).
- The NAS store is **external state owned by modelctl** (ADR-0004); Irori reads `catalog.json` and mutates only through modelctl commands.
- Secrets table: SSH credentials + agent tokens encrypted AES-256-GCM under `ENCRYPTION_KEY`.
- Desired clock state per node; re-applied on node online transitions (ADR-0003).

## Integrations

- **Agent link:** outbound WS `/agent-ws`, token auth, resume cursor, `config-update` for rotation; SSH bootstrap/fallback with identical snapshot shapes.
- **Browser link:** SSE `/api/v1/events` (snapshot, run-log, job, bench events); REST for actions.
- **modelctl:** subprocess with pinned minimum version; streamed job output; dry-run → armed applies for destructive ops.

## Deployment and Operations

- One Dockerfile, two roles (`server`, `agent`); compose happy path for the server on any LAN computer; the agent's primary install is bare-metal (bundle + root systemd unit via install script, UI-assisted over SSH).
- Validation gates: `pnpm test`, `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check`; CI builds amd64 + arm64 (M7).

## Agent-Guided Maintenance Boundary

When the agent-guided bootstrap workflow is used, repository evidence and agent proposals are untrusted. The deterministic core owns rendering, planning, apply, rollback, and validation. The agent stops after preview; a human separately confirms the recomputed plan in an interactive terminal. See `docs/AGENT_GUIDED.md`.

## Architecture Decision Index

Read `docs/adr/README.md` before individual decision records. Update this overview when an accepted ADR changes the current architecture.
