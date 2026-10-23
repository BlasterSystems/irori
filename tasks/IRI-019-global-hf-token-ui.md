# Task: Global HF token set from the UI (IR-73)

## Objective

Let the owner define ONE global Hugging Face token from the web UI. The token is
stored hub-side (settings table), pushed to all agents via the existing
`config-update` frame, and used (a) by the agent as `HF_TOKEN` on the modelctl
child env and (b) hub-side by `GET /api/v1/hf-quants` for gated/private repos.
The token is **always optional** — absence is never an error path, and
tokenless flows behave byte-identically to today.

Owner decisions (2026-10-23): one global token (not per-node); hub-side quants
listing uses it; token always optional. Jira: IR-73 (sprint 985, full-stack,
no `backend` label).

## Acceptance criteria

- [ ] `GET /api/v1/settings/hf-token` answers `{ configured: boolean }` — the
      token itself never appears in any GET body.
- [ ] `PUT /api/v1/settings/hf-token` accepts `{ hfToken: string | null }`;
      null clears; after any change every online agent gets a `config-update`.
- [ ] Agent applies the token from `config-update` (string = set, null =
      clear, absent = keep); server-set token wins over `IRORI_HF_TOKEN` env
      (env stays bootstrap fallback); `agent-update` jobs still get no token.
- [ ] `GET /api/v1/hf-quants` sends `Authorization: Bearer …` only when a
      token is configured; without one the request is unchanged.
- [ ] Footer gear button opens a Hub settings modal (write-only token field,
      tri-state: blank keeps current, explicit Clear).
- [ ] Jobs no-credentials contract intact: token never in job params,
      job-output frames, or any GET response.
- [ ] Token optional at every layer; no schema, route, or UI step requires it.

## Scope

### Included

- `packages/core`: `configUpdateMsgSchema.hfToken` (nullish), new
  `hf-token.ts` wire schemas (status + put).
- `packages/db`: none (the `settings` table already exists).
- `apps/server`: `hf-token.ts` service (settings row), GET/PUT routes, hub
  `getHfToken` dep in `sendConfigUpdate`, `hf-quants.listQuants(repo, token?)`,
  `getHub` Pick extended with `refreshConfig`.
- `apps/agent`: transport stores token from `config-update`
  (`getHfToken()`), `main.ts` ctx factory precedence, config.ts doc comment.
- `apps/web`: `HubSettingsModal.vue`, footer gear in `App.vue`, `api.ts`
  fetch/put helpers.
- Docs: dated addendum under ADR-0009; CONFIGURATION.md; DEPLOYMENT.md.

### Excluded

- Per-node tokens (owner chose global).
- Encrypting the token at rest (homelab posture per ADR-0002 — same class as
  the existing settings rows and hello token).
- Agent-side persistence of the token (re-fetched on every hello).

## Plan

- [x] Inspect hub/transport/app/api wiring and settings-table precedents
- [x] Confirm architecture impact (ADR-0009 addendum, owner-accepted pattern)
- [x] Implement core schemas → server → agent → web
- [x] Add/update tests alongside behavior
- [x] Update documentation
- [x] Run validation + live smoke

## Architecture impact

- **ADR required:** Yes — dated implementation-note addendum under ADR-0009
  (the owner-accepted resolution pattern; ADR-0009 owns the download/HF
  surface and IRI-017 documented the previous token posture).
- **Relevant ADRs:** ADR-0002 (secrets/no-auth posture), ADR-0003
  (privileged agent, outbound WS), ADR-0009 (download queue + HF surface).
- **Proposed ADR:** none.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` passed (python3.12 — the
  repo default `python3` is 3.9, too old for `tomllib`).
- Tests: `pnpm -r test` green against a disposable Postgres
  (`IRORI_TEST_DATABASE_URL`, `postgres:16-alpine` on :54329) — core 74,
  web 201, proxy 22, db 4, agent 140, server 174. New: core hf-token wire
  contracts (set/clear/absent compat + PUT/GET bodies), server service
  round-trip (db-gated) + route tests (presence-only GET, 503 degraded, set/
  clear + push capture, 400s) + hub frame test + hf-quants Authorization
  cases + agent transport set/clear/keep + JobManager child-env (fake
  modelctl prints `HF_TOKEN`) + web api + chrome pins.
- Build: `pnpm -r build` green; typecheck green (web via vue-tsc).
- Documentation check: `.agentic/bin/docs-check` exit 0; the new endpoints
  were added to SPEC §13 Meta row (clears the API-docs heuristic warning).
- Live smoke (disposable PG + built server on :3948): `GET /api/v1/settings/
  hf-token` → `{configured:false}`; PUT → `{configured:true}` (token never in
  a GET body); fake agent hello → `config-update` carried the token; a PUT
  while the agent stayed connected pushed a fresh `config-update` on the same
  connection (no reconnect); `GET /api/v1/hf-quants?repo=unsloth/flint-GGUF`
  → 200; browser (real dist + real API): footer gear → modal, Clear →
  `{configured:false}`, Save → `{configured:true}` + pushed frame. Smoke
  stack torn down (container `--rm`, server killed).

## Review

- Correctness: tri-state frame semantics (string/null/absent) covered both
  compat directions; server-wins precedence with `IRORI_HF_TOKEN` env as
  bootstrap fallback; `agent-update` still excluded from the token (guard
  unchanged, jobs.ts:162).
- Security: token is write-only via the API (GET is presence-only), never in
  job params or job-output frames; reaches modelctl as the `HF_TOKEN` child
  env only. Stored plaintext in `settings` + config-update frames — same
  exposure class as the hello token (ADR-0002 homelab posture), recorded in
  the ADR-0009 addendum.
- Compatibility: old agents strip the unknown config-update key; old servers
  omit it (agent keeps env). Settings routes 503 degraded; hf-quants lists
  tokenless when the service is absent.
- Residual risks: a hub DB read failure at config-update time omits the key
  (agent keeps its current token — self-heals on the next push/hello). The
  token is visible to anyone with hub API access (no app auth, accepted).
  Real gated-repo download with a live token remains a manual owner check
  (needs a real token; the header behavior is unit-verified).
