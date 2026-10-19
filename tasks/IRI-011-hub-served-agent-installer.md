# Task: Hub-served agent installer (IRI-011 / IR-57)

## Objective

A user can install the agent on a node using only hub reachability: the modal
offers the script download and a copyable one-liner, and the hub serves
`install-agent.sh`, `irori-agent.service` and the agent bundle itself — no
GitHub access required on the node.

## Acceptance criteria

- [ ] `GET /install-agent.sh`, `GET /irori-agent.service`,
      `GET /agent/irori-agent.mjs` serve the repo copies (server image ships
      them; monorepo dev resolves `apps/agent` directly). 503 JSON when the
      artifact is missing.
- [ ] NodeModal token reveal shows a Download link and a copyable three-line
      install block (`curl` script + unit, then run with `--server`,
      `--token`, `--bundle-url` filled from `location`).
- [ ] `docker/Dockerfile` server role copies the three artifacts and points
      `IRORI_AGENT_ARTIFACTS_DIR` at them.
- [ ] Docs updated (`DEPLOYMENT.md`, `API.md`); routes work while degraded.

## Scope

### Included

- Server artifact routes + resolver (env override, monorepo default).
- NodeModal install block (IRI-010's usage line replaced by the copyable
  block; env block unchanged).
- Image packaging + docs.

### Excluded

- SSH-assisted install (discarded by owner — no credentials, ever).
- Update flow (IRI-012).

## Plan

- [x] Inspect serving/static wiring (`app.ts` SPA fallback ordering), artifact
      sources (`apps/agent/install-agent.sh`, `apps/agent/irori-agent.service`,
      `apps/agent/dist/irori-agent.mjs`), Dockerfile.
- [x] Confirm architecture impact → ADR-0007.
- [x] Implement routes + resolver + modal block + Dockerfile.
- [x] Tests: route 200s with fixture artifacts, 503 when missing.
- [x] Update docs.
- [x] Run validation.

## Architecture impact

- **ADR required:** Yes — deployment artifact sourcing + unauthenticated-hub
  serving posture (ADR-0007; extends ADR-0003, references ADR-0002).
- **Relevant ADRs:** 0002 (no app auth; secrets never served), 0003 (agent
  bootstrap remains privileged; SSH stays out of scope).
- **Proposed ADR:** 0007-hub-served-agent-artifacts-and-updates.md

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed.
- Tests: `pnpm test` green — 410 total (core 49, db 4, agent 123, web 136,
  server 98, DB-backed suites against a disposable Postgres). One
  load-sensitive flake observed once in the agent package under the parallel
  run; 123/123 in isolation and in two further full runs — unrelated to this
  change (no timing paths touched).
- Build: `pnpm build` — green (vue-tsc + tsc + vite + esbuild).
- Documentation check: `.agentic/bin/docs-check` — passed.
- Live smoke (real server on a scratch DB + scripted WS agent): served
  `/install-agent.sh`, `/irori-agent.service` and `/agent/irori-agent.mjs`
  are byte-identical (sha256) to the repo copies / built bundle (2.37 MB);
  `/api/v1/version` returns the hub version.

## Review

- Correctness: routes registered before the SPA fallback; degraded mode
  unaffected; artifacts sourced from one place (`apps/agent`).
- Security: the script contains no secrets (token is passed by the operator at
  run time); the hub already serves its UI unauthenticated to the LAN
  (ADR-0002) — this adds no new exposure class.
- Compatibility: no API contract changes; additive routes only.
- Residual risks: a hub serving a hostile script would be a hub compromise
  scenario (already implied by ADR-0002's trust model); GitHub remains the
  release-artifact fallback via `--bundle-url`.
