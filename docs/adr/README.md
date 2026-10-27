# Architecture Decision Records

Read this index before loading individual ADRs. Load only records relevant to the current scope, component, tag, or question.

## Lifecycle

Valid statuses are `Proposed`, `Accepted`, `Rejected`, `Deprecated`, and `Superseded`.

Accepted records are historical. Create a new ADR to replace a decision, mark the old record `Superseded`, and link both records.

## Index

| ADR | Status | Scope | Tags | Summary | Supersedes |
|---|---|---|---|---|---|
| [ADR-0001](0001-typescript-pnpm-monorepo.md) | Accepted | Repository topology, runtime language, server framework, UI stack | architecture, monorepo, typescript, express, vue, agent | One pnpm/TypeScript workspace; Node 24, Express 5, Vue 3 + Vite; shared contracts in `packages/core`, storage in `packages/db`, agent in `apps/agent` | None |
| [ADR-0002](0002-postgresql-on-proxmox-storage.md) | Accepted | Persistence engine, schema tooling, retention, secrets at rest, auth posture | storage, postgres, drizzle, encryption, security, homelab, proxmox | PostgreSQL on the existing Proxmox pgsql server via `DATABASE_URL` + Drizzle; no app auth (homelab); SSH credentials + agent tokens AES-256-GCM | None |
| [ADR-0003](0003-privileged-agent-outbound-ws.md) | Accepted | Node-side runtime, transport topology, privilege model, bootstrap | agent, websocket, systemd, security, transport | Root systemd agent per node; outbound WS with per-node tokens; SSH bootstrap/fallback; snapshot parity; clock reconcile on reconnect | None |
| [ADR-0004](0004-modelctl-as-supply-chain-engine.md) | Accepted | Model store compatibility, transfer engine, HF integration | modelctl, nas, hf, subprocess, storage | Agent drives `modelctl` for all store mutations; `catalog.json` read-only contract; dry-run-then-armed destructive ops; no NAS migration | None |
| [ADR-0005](0005-blasterystems-design-system-vue-port.md) | Accepted | UI framework, visual language, theming, branding | frontend, vue, design-system, blastersystems, branding | Vue 3 + token-only port of the BlasterSystems DS (uptime-monitoring recipes); Irori lockup + ink-tile favicon | None |
| [ADR-0006](0006-telemetry-first-pipeline.md) | Accepted | Data collection, streaming, storage, live updates | telemetry, sse, websocket, rollups, architecture | Agent push → validated snapshots → rings/rollups → SSE hub; versioned contracts; bounded retention | None |
| [ADR-0007](0007-hub-served-agent-artifacts-and-updates.md) | Accepted | Agent onboarding artifacts, update path, server image contents, job-kind surface | agent, deployment, security, websocket, jobs, docker | Hub serves its own version's installer/unit/bundle; updates dispatch as an `agent-update` WS job running in a `systemd-run` transient unit; no credentials, hello-driven settlement. Accepted 2026-10-21 (owner, after production proof on all four fleet nodes) | None |
| [ADR-0008](0008-capture-proxy-usage-telemetry.md) | Accepted | Usage capture architecture, node-side buffer, sync transport, storage, retention, listener security posture | usage, proxy, capture, agent, websocket, postgres, sqlite, retention, security | In-agent pass-through capture proxy (`packages/proxy`): flagged setups forward loopback engines through an agent listener; raw byte pipe + passive tee; node SQLite WAL buffer → batched WS → Postgres (`llm_requests` + ingest-time buckets), 90 d raw / 1 y rollups. Accepted 2026-10-20 (owner, M8 planning session) | None |
| [ADR-0009](0009-server-side-download-queue-nas-placement.md) | Accepted | Model downloads, model-ops node selection, queue durability | downloads, queue, jobs, nas, modelctl | Adding a download always queues server-side; pending entries batch into one `download-queue` job on the NAS-preferred store node; batch outcomes reconcile from modelctl terminal output; retry reuses published objects. Accepted 2026-10-21 (owner, after IRI-014/015 implementation) | None |
| [ADR-0010](0010-usage-phase2-retention-attribution-identity.md) | Proposed | Usage phase 2: body retention, chats reconstruction, tool attribution, client identity | usage, proxy, capture, retention, privacy, postgres, attribution, identity | Opt-in content-addressed body retention (sha256 gzip parts, refcounted, die with owning rows, 16/4 MiB caps, browsers get metadata only); read-time session chaining with compaction markers; capture-time tool attribution summing to request totals; client identity via issued keys / `X-Irori-*` headers (identification, not auth); executes ADR-0008's phase-2 revisit trigger | None |
| [ADR-0011](0011-per-node-cache-user-transfers.md) | Accepted | Transfer cache ownership: sync-local and push user, runuser surface, node registry field | modelctl, hf-cache, runuser, transfers, security, jobs | Transfers run as the node's `cache_user` via `runuser` (user's modelctl, scrubbed env); push destinations addressed `user@host`; unset = root. Accepted 2026-10-26 (owner, after the IR-101 root-cache report) | None |
| [ADR-0012](0012-register-local-without-transfer.md) | Accepted | Register-from-cache: register-local job, inventory orphans, node-page Register action | modelctl, hf-cache, jobs, inventory, security | Registrations without transfer go only through `modelctl register-local` (verify-then-register, fails closed); agent maps it as a per-user job, inventory reports orphan `models--*` dirs, UI offers Register. Accepted 2026-10-27 (owner, IR-104) | None |

## When an ADR is required

Use an ADR for durable, cross-cutting, security-sensitive, data, deployment, foundational dependency, or external integration decisions. Routine refactors and local implementation details normally do not require one.

Copy `template.md` to `NNNN-short-title.md`, choose the next unused four-digit number, and update this index.
