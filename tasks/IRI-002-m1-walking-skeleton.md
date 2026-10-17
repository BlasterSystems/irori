# Task: IRI-002 — M1 Walking skeleton

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M1)

## Objective

A runnable end-to-end slice: pnpm workspace (TS strict) with
`apps/server` (Express 5: `/healthz`, node registry CRUD, SSE hub, PostgreSQL
on the Proxmox pgsql server via Drizzle — `DATABASE_URL`, migrations on boot),
`apps/web` (Vue 3 + BlasterSystems DS shell + brand lockup +
theme machinery, empty Overview), `apps/agent` (outbound WS hello + token auth
+ one hardware snapshot), `packages/core` (snapshot contract), `packages/db`
(nodes, snapshots, settings, secrets). Multi-stage Dockerfile with server/agent
roles + compose.

## Acceptance criteria

- [ ] `docker compose up` boots the server; `/healthz` ok; SPA served.
- [ ] Server connects to the Proxmox PostgreSQL via `DATABASE_URL`; Drizzle
      migrations apply on boot (idempotent); DB loss degrades gracefully
      (in-memory rings, buffered ingest, reconnect).
- [ ] Agent installed on one machine connects out, authenticates with its
      token, and its node appears live in the UI with a hardware snapshot.
- [ ] Snapshot contract shared via `packages/core` (zod-validated on ingest).
- [ ] DS: tokens (light/dark), fonts, `.brand-mark` lockup ("Irori" +
      endorsement), favicon, theme persist — visually verified light/dark.
- [ ] Mobile 390px: no horizontal page overflow on any screen; topbar two-row
      with scrollable nav; drawers/wizard full-bleed sheets; tables scroll
      with sticky first column; touch targets ≥ 44px.
- [ ] `pnpm test`, `pnpm build`, `.agentic/bin/validate`, docs-check green.

## Scope

### Included

- Workspace tooling (pnpm, TS strict, vitest, eslint+prettier).
- M1 tables only: nodes, snapshots (ring table), settings, secrets.
- Agent: single-file esbuild bundle; hello handshake (schemaVersion,
  agentVersion, token); one snapshot push per server-configured cadence.
- Server: agent hub with per-node token check; SSE broadcast of snapshots.

### Excluded

- Collectors beyond a basic hardware snapshot (M2), LLM probes (M3), model
  ops (M4), serving (M5), benchmarks (M6), analytics (M7), SSH fallback
  transport (M2), Docker agent runtime testing on Spark (M7).

## Plan

- [ ] Research briefs: agent systemd unit layout on DGX OS; DS token port diffs.
- [ ] Contracts first in `packages/core`; then db → server → agent → web.
- [ ] Add or update tests per component (db on `:memory:`; hub with fake WS).
- [ ] Update README + docs; run validation; live smoke with one real node.

## Architecture impact

- **ADR required:** No — implements ADR-0001/0002/0003/0005/0006.
- **Relevant ADRs:** 0001, 0002, 0003, 0005, 0006.
- **Proposed ADR:** None.

## Validation evidence

- 2026-10-17: `pnpm build` green (all 5 packages); tests: core 9/9, server 32/32,
  agent 10/10, web 16/16; db 4/4 **against a real Postgres 16 container**
  (`IRORI_TEST_DATABASE_URL`, migrations + token encrypt/verify/rotate +
  prune; CI will run this via service container).
- Live smoke (this Mac as the agent machine): dockerized Postgres 16 →
  `apps/server/dist/index.js` (boot log: listening / database migrated / hub
  ready) → POST /api/v1/nodes (token returned once) → agent bundle
  `apps/agent/dist/irori-agent.mjs` handshake → hello-ok → snapshots at 1 s.
  Verified: `online:true`, `GET /api/v1/nodes/:id/snapshot` live payload,
  SSE frames on `/api/v1/events` (snapshot + heartbeat), 30+ rows in
  `snapshots` table; restart of the stack re-handshakes cleanly.
- UI (browser): Overview renders the live spark1 card (CPU/MEM barrows,
  HEAD/SPARK/ONLINE chips, Agent 0.1.0), LIVE·1s chip pulsing via SSE; theme
  toggle verified dark + light; 390 px viewport → no horizontal overflow
  (scrollWidth == clientWidth).
- Docker: multi-stage build; server-role image boots, migrates against
  remote Postgres, `/healthz` → `{"ok":true,"db":true}`; agent role bundles
  `dist/irori-agent.mjs`. Compose in `docker/compose.yml` (dev postgres
  profile).
- `.agentic/bin/validate` + `.agentic/bin/docs-check` green.

## Review

- (pending)
