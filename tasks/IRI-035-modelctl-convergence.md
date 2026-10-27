# Task: IRI-035 — Modelctl convergence: hub-pinned pin, per-cache-user provisioning, inventory-triggered installs

- **Ticket:** IR-106 (sprint 990)
- **Status:** implemented; ADR-0013
- **Design:** owner-selected 2026-10-27 (hub pin in config-update; auto-dispatch after inventory reads) — no research brief needed (all evidence in-repo).

## Objective

Keep modelctl current on every node without per-node SSH: the hub owns the
pin, cache users get their own provisioning, and version checks happen
before installs so nothing ever downgrades.

## Product manager summary

- **One-liner:** the hub pins a modelctl version, pushes it via config-update, and auto-installs it per cache user whenever an inventory read finds a node below the pin.
- **User value:** transfers/delete/register keep working after a modelctl release without manual per-user `uv` installs.
- **Business impact:** removes the recurring ops toil (dgx1 piresbruno was on 0.20.1 while root moved).
- **Success metric:** a below-pin cache user converges after its next models-inventory read, visible as a `modelctl-install {user}` job in the drawer.
- **Dependencies & constraints:** none; the pin is unset by default (feature off) — arming is deliberate.

## Acceptance criteria

- [ ] `GET/PUT /api/v1/settings/modelctl-pin` persists the pin; PUT pushes config-update to online agents.
- [ ] `modelctl-install {user}` provisions the cache user's own modelctl (runuser, resolved home/binary); no user = the agent's own.
- [ ] The install script skips (exit 0) when the current version ≥ pin — never downgrades.
- [ ] On a succeeded models-inventory settle, the hub dispatches one install job per below-pin cache user; silent skip when the pin is unset, the node is busy, or the agent is offline.
- [ ] Tests + docs (SPEC §6/§13, CONFIGURATION.md, CHANGELOG, ADR-0013) green.

## Scope

### Included

- Core: setting schema, config-update `modelctlPin` (tri-state), pin regex.
- Agent: builder `user` param + runuser wrapper + skip-if-newer; ctx pin prefers config-update.
- Server: setting service + routes + hub getter + jobs auto-dispatch hook.

### Excluded

- Settings-modal UI entry (the setting is API-managed; add later if wanted).
- Retry backoff for failing installs (revisit trigger in ADR-0013).

## Plan

- [x] Implement core/agent/server.
- [x] Tests (core, agent argv matrix, server routes, job-events dispatch).
- [x] Docs + ADR-0013.

## Architecture impact

- **ADR required:** Yes — auto-installing binaries as other users is a durable, security-relevant agent behavior. See `docs/adr/0013-modelctl-convergence.md`.
- **Relevant ADRs:** 0004, 0011, 0007.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` passed.
- Tests: server 196/196 (db-gated, disposable PG; new route + dispatch tests), agent green (new argv matrix), core green (new schema tests); `pnpm build` green.
- Documentation check: `.agentic/bin/docs-check` passed.
- Live: hub config-update carries `modelctlPin`; arming the setting converges a below-pin cache user after its next inventory read.

## Review

- Correctness: dispatch happens after the inventory settle (terminal), guarded by JobBusyError/JobDispatchError; the install script never downgrades.
- Security: the agent only ever runs the fixed provisioning script (uv → pinned GitHub tag) as the named cache user with a scrubbed env; the hub never sends paths.
- Compatibility: `modelctlPin` is nullish — old servers omit it (agents keep env), old agents strip it; the pin defaults to unset (feature off).
- Residual risks: failing installs retry on the next inventory read without backoff (ADR revisit trigger).
