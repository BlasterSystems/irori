# Task: Hub-driven agent updates (IRI-012 / IR-58, blocked by IRI-011)

## Objective

One click updates an online agent to the hub's own version over the existing
token-authenticated WS link — no credentials, no SSH, no manual per-node work.
Offline agents fall back to IRI-011's manual one-liner.

## Acceptance criteria

- [ ] `POST /api/v1/nodes/:id/agent-update` dispatches an `agent-update` job
      (params `{ expectedVersion }`), refused 409 while a job / bench /
      running setup occupies the node, 503 degraded, 404 unknown node.
- [ ] Agent executes the update as a `systemd-run --pipe --wait` transient
      unit (survives the agent's own restart; the unit has no `KillMode`, so
      the systemd default `control-group` would otherwise kill the job):
      fetch hub bundle → `node --check` → keep `.bak` → atomic `mv` →
      `systemctl restart irori-agent`.
- [ ] Pre-restart failures settle normally via `job-done`; the restart itself
      kills the socket, so success settles on the node's next hello
      (`settleAgentUpdate` via a hub `onHello` hook): reported version ==
      `expectedVersion` → succeeded, else left running.
- [ ] `reapOffline` skips `agent-update` rows for `AGENT_UPDATE_GRACE_MS`
      (10 min) after dispatch and fails them with a rollback hint after that;
      no timers/maps — the existing 60 s reaper loop enforces it, so it is
      restart-safe.
- [ ] Nodes list + drill-down show the drift (agentVersion ≠ server version);
      NodeDetail has the Update button with a status line polling the job.
- [ ] No schema changes.

## Scope

### Included

- core: `agent-update` job kind; server: dispatch route, settle hook, reaper
  carve-out, `GET /api/v1/version`; agent: update job branch; web: badge +
  button + status; docs + ADR-0007.

### Excluded

- Automatic/scheduled updates (operator clicks, per SPEC's no-surprise rule).
- Credential-bearing install paths (discarded).

## Plan

- [x] Inspect jobs-service (create/reap/settle), hub hello/close, agent
      JobManager branch pattern (hygiene), web job clients (models.ts).
- [x] Confirm architecture impact → ADR-0007 (shared with IRI-011).
- [x] Implement core kind → server → agent → web.
- [x] Tests: kind accepts update; reaper skip/timeout; settle on hello
      (succeeded / mismatch leaves running / offline timeout); route guards.
- [x] Update docs.
- [x] Run validation.

## Architecture impact

- **ADR required:** Yes — security-sensitive agent job surface + deployment
  update contract (ADR-0007).
- **Relevant ADRs:** 0003 (privileged agent, server-supplied jobs), 0004
  (job-kind precedent), 0006 (validated contracts).
- **Proposed ADR:** 0007-hub-served-agent-artifacts-and-updates.md

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed.
- Tests: `pnpm test` green — 410 total (see IRI-011 evidence). New: core kind
  test, `agent-update.test.ts` (agent: argv shape, env derivation, no-URL
  guard), `agent-update.test.ts` (server, DB integration: young-row reaper
  skip, aged-out failure with rollback hint, settle on match / pending on
  mismatch / none when idle), `onboarding.test.ts` (route 200s, 503, 409
  gates incl. too-old agent, busy bench/setup), hub `onHello` spy test.
- Build: `pnpm build` — green.
- Typecheck: `pnpm typecheck` (the CI `verify` gate — includes `test/`, which
  `pnpm build` does not) — green after supplying `serverUrl` in
  `apps/agent/test/m4.test.ts`'s JobManager context.
- Documentation check: `.agentic/bin/docs-check` — passed.
- Live smoke (real server on a scratch DB + scripted WS agent): agent at
  0.2.0 → `409 predates self-update (needs 0.3.0)`; agent at 0.3.0 → `202`,
  `agent-update` job frame received over the existing socket with
  `expectedVersion`; simulated restart (socket close) + re-hello with the
  hub version → job settled `succeeded` with the streamed output line and
  `update confirmed: agent reports 0.2.0`. The real `systemd-run` execution
  is covered by the argv/script assertions; it needs a privileged node —
  first dev deploy is the end-to-end proof.

## Review

- Correctness: all four completion paths covered (pre-restart job-done,
  hello-settle, reaper timeout, server-restart orphan).
- Security: the update script is agent code, not server-controlled shell —
  the job kind enum grows, params stay an opaque record the agent ignores;
  the hub URL derives from the agent's own `IRORI_SERVER_URL`. Restart
  kills running setups/benches — refused server-side (409) for bench +
  running setups, and stated in the UI copy.
- Compatibility: additive endpoints + one job kind; older agents simply
  never receive the kind (server refuses to dispatch to offline, and
  `isAgentSupported` gates hello).
- Residual risks: a failed restart leaves the node offline (`.bak` +
  journalctl hint in the job output); update target is always the hub's
  version — rolling the hub back requires re-dispatching after the rollback.
