# ADR-0001: TypeScript pnpm monorepo (Node 24, Express 5, Vue 3)

- **Status:** Accepted
- **Accepted:** 2026-10-19 — owner approval after M1–M7 shipped on these decisions
- **Date:** 2026-10-16
- **Decision owners:** piresbruno
- **Scope:** Repository topology, runtime language, server framework, UI stack
- **Tags:** architecture, monorepo, typescript, express, vue, agent
- **Supersedes:** None
- **Superseded by:** None

## Context

Irori replaces four projects written in three stacks (React/Node dashboards, a
Python CLI, a bash script). The new system needs a server (REST + SSE + agent
hub), a web UI, and a per-node agent that share strict contracts (snapshot
shapes, store layout, job protocol). The reference implementation
(`uptime-monitoring`) already proves a pnpm/TypeScript monorepo with
`apps/{server,web}` + `packages/{core,db,agent}` and shares contracts through
`packages/core`. The server must run in a Docker container on any LAN computer;
the agent must run on DGX Sparks (arm64, DGX OS) and on a NAS.

## Decision drivers

- One language across server, web, and agent keeps the shared contracts
  type-checked end to end (snapshot schema drift was a real cost in the source
  projects).
- The agent ships as a small esbuild bundle + systemd unit; Node has first-class
  WS/SSE and arm64 support; no cross-compilation.
- `packages/core` must be importable by agent and server without the UI bundle.
- The Python `modelctl` stays external (ADR-0004) — no Python in this repo.
- Single developer; one toolchain, one test runner, one lint config.

## Considered options

### Option 1: pnpm + TypeScript monorepo (chosen)

`apps/server` (Express 5), `apps/web` (Vue 3 + Vite), `apps/agent`,
`packages/core` (contracts, zod schemas), `packages/db` (Drizzle). Matches the
proven uptime-monitoring layout; shared types from day one; pnpm workspaces
handle the agent-bundle build cleanly.

### Option 2: Keep the sparkDash React codebase and extend

Fastest start for the dashboard, but drags the full legacy feature surface
(ancillary integrations, analysis proxy) that this project explicitly drops,
mixes plain-JS server code, and has no agent-first architecture. Reuse would be
archaeology, not a foundation.

### Option 3: Polyglot (Go/Rust agent, Python server)

Best per-component performance and single-binary agents, but three toolchains
for a single developer, slower iteration on the contract surface, and the NAS
already needs Python for modelctl — the agent itself is I/O-bound.

## Decision

Option 1. pnpm workspaces, TypeScript strict everywhere; Node.js 24 LTS;
Express 5 for `apps/server`; Vue 3 + Vite for `apps/web` (see ADR-0005);
`apps/agent` built as a single esbuild bundle. `packages/core` owns all
cross-process contracts (snapshots, agent protocol, store layout constants,
job messages) and is the only shared dependency of agent and server.

## Consequences

### Positive

- End-to-end type safety on the agent↔server↔browser contract surface.
- Proven component/layout recipes can be ported from uptime-monitoring.
- One build/test/lint pipeline; `pnpm build` / `pnpm test` workspaces-wide.

### Negative

- Rewriting proven React dashboard components in Vue (mitigated: only the
  narrowed feature set is rebuilt).
- Node runtime on the NAS (mitigated: static bundle + pinned Node in the
  install script; NAS agent is the same bundle).

### Risks and mitigations

- Node version churn on arm64 → pin Node 24 LTS in the agent install script;
  contract tests run in CI on both amd64 and arm64.

## Implementation and validation

M1 creates the workspace with `pnpm build`, `pnpm test` (vitest),
`.agentic/bin/validate` green; `packages/core` consumed by both `apps/server`
and `apps/agent` in the walking skeleton; CI builds amd64 + arm64 (M7).

## Revisit triggers

- A node type appears that cannot run Node 24 (no plausible homelab case).
- The agent needs a component model that esbuild+Node cannot deliver.

## References

- SPEC §2; PLAN M1; ADR-0003 (agent topology), ADR-0005 (UI stack).
- `~/Developer/uptime-monitoring` (reference monorepo), `AGENTS.md`.
