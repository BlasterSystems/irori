# Architecture Decision Records

Read this index before loading individual ADRs. Load only records relevant to the current scope, component, tag, or question.

## Lifecycle

Valid statuses are `Proposed`, `Accepted`, `Rejected`, `Deprecated`, and `Superseded`.

Accepted records are historical. Create a new ADR to replace a decision, mark the old record `Superseded`, and link both records.

## Index

| ADR | Status | Scope | Tags | Summary | Supersedes |
|---|---|---|---|---|---|
| [ADR-0001](0001-typescript-pnpm-monorepo.md) | Proposed | Repository topology, runtime language, server framework, UI stack | architecture, monorepo, typescript, express, vue, agent | One pnpm/TypeScript workspace; Node 24, Express 5, Vue 3 + Vite; shared contracts in `packages/core`, storage in `packages/db`, agent in `apps/agent` | None |
| [ADR-0002](0002-sqlite-first-storage-encrypted-secrets.md) | Proposed | Persistence engine, schema tooling, retention, secrets at rest, auth posture | storage, sqlite, drizzle, encryption, security, homelab | SQLite (WAL) at `/data/irori.db` via Drizzle; no app auth (homelab); SSH credentials + agent tokens AES-256-GCM | None |
| [ADR-0003](0003-privileged-agent-outbound-ws.md) | Proposed | Node-side runtime, transport topology, privilege model, bootstrap | agent, websocket, systemd, security, transport | Root systemd agent per node; outbound WS with per-node tokens; SSH bootstrap/fallback; snapshot parity; clock reconcile on reconnect | None |
| [ADR-0004](0004-modelctl-as-supply-chain-engine.md) | Proposed | Model store compatibility, transfer engine, HF integration | modelctl, nas, hf, subprocess, storage | Agent drives `modelctl` for all store mutations; `catalog.json` read-only contract; dry-run-then-armed destructive ops; no NAS migration | None |
| [ADR-0005](0005-blasterystems-design-system-vue-port.md) | Proposed | UI framework, visual language, theming, branding | frontend, vue, design-system, blastersystems, branding | Vue 3 + token-only port of the BlasterSystems DS (uptime-monitoring recipes); Irori lockup + ink-tile favicon | None |
| [ADR-0006](0006-telemetry-first-pipeline.md) | Proposed | Data collection, streaming, storage, live updates | telemetry, sse, websocket, rollups, architecture | Agent push → validated snapshots → rings/rollups → SSE hub; versioned contracts; bounded retention | None |

## When an ADR is required

Use an ADR for durable, cross-cutting, security-sensitive, data, deployment, foundational dependency, or external integration decisions. Routine refactors and local implementation details normally do not require one.

Copy `template.md` to `NNNN-short-title.md`, choose the next unused four-digit number, and update this index.
