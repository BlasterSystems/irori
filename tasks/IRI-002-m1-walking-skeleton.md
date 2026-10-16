# Task: IRI-002 — M1 Walking skeleton

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M1)

## Objective

A runnable end-to-end slice: pnpm workspace (TS strict) with
`apps/server` (Express 5: `/healthz`, node registry CRUD, SSE hub, SQLite via
Drizzle/WAL), `apps/web` (Vue 3 + BlasterSystems DS shell + brand lockup +
theme machinery, empty Overview), `apps/agent` (outbound WS hello + token auth
+ one hardware snapshot), `packages/core` (snapshot contract), `packages/db`
(nodes, snapshots, settings, secrets). Multi-stage Dockerfile with server/agent
roles + compose.

## Acceptance criteria

- [ ] `docker compose up` boots the server; `/healthz` ok; SPA served.
- [ ] Agent installed on one machine connects out, authenticates with its
      token, and its node appears live in the UI with a hardware snapshot.
- [ ] Snapshot contract shared via `packages/core` (zod-validated on ingest).
- [ ] DS: tokens (light/dark), fonts, `.brand-mark` lockup ("Irori" +
      endorsement), favicon, theme persist — visually verified light/dark.
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

- (pending)

## Review

- (pending)
