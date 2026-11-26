# Task: IRI-156 (IR-270): agent installer re-runs apply config; wss:// behind TLS proxy; clearer failure output

## Objective

Re-running `install-agent.sh` with a corrected `--server`/`--token`/bundle must take effect. The Add-node modal must hand out a WebSocket URL that works behind the TLS reverse proxy. A failed install must show why it failed.

Design: `tasks/research-agent-install-behind-tls-proxy.md`.

## Product manager summary

- **One-liner:** Fixing a bad agent install is just re-running the copied command.
- **User value:** No more silent 60 s timeouts. dgx-4 sat on a stale `ws://` URL for over an hour because re-runs never restarted the unit.
- **Business impact:** Faster node onboarding; fewer support loops.
- **Success metric:** A re-run after a wrong `--server` reaches `handshake ok`. A failed run prints the agent's actual error.
- **Dependencies & constraints:** LAN installs (`ws://HOST:3947`) must keep working unchanged. Warnings are warn-only.

## Acceptance criteria

- [x] AC0: the installer runs `systemctl enable` then `systemctl restart`. The `handshake ok` wait only reads journal lines since a timestamp captured before the restart.
- [x] AC1: the Add-node modal shows `wss://<host>/agent-ws` on https pages and `ws://` on http; a test covers both.
- [x] AC2: on timeout the installer prints the agent's last `connection error`/`server error` lines.
- [x] AC3 (warn-only): a preflight upgrade probe warns on 3xx ("use wss://"), on a non-101 response ("proxy not forwarding WebSocket upgrades"), and on an unreachable host.
- [x] AC4: `docs/DEPLOYMENT.md` gets a "Behind a TLS reverse proxy" section, and the stale hub addresses are fixed.

## Scope

### Included

- `apps/agent/install-agent.sh`, `apps/web/src/components/NodeModal.vue` (+ a pure URL helper), docs and env examples.

### Excluded

- Agent following redirects or rewriting ws→wss (rejected in research).
- Historical task/research files that cite 10.20.30.x (point-in-time records).

## Implementation plan

### Files to modify or create

- `apps/web/src/agent-urls.ts`: new `agentWsUrl(loc)` / `hubHttpBase(loc)` helpers.
- `apps/web/src/components/NodeModal.vue`: use the helpers.
- `apps/web/test/agent-urls-iri156.test.ts`: unit tests.
- `apps/agent/install-agent.sh`: preflight, restart, time-bounded wait, error tail.
- `docs/DEPLOYMENT.md`, `.env.example`, `deploy/.env.example`, `deploy/docker-compose.yml`: addresses and the TLS-proxy section.

### Key changes

- Scheme: `https:` → `wss:`, everything else → `ws:`.
- Installer: `START_TS` captured before the restart; `journalctl --since "$START_TS"`.

### Test approach

- Vitest unit tests for the URL helpers; the existing modal test stays green.
- `bash -n` plus a live preflight probe against the dev hub (direct `ws://10.0.10.9:3947`, `wss://irori.as267.com`, `ws://irori.as267.com` → 301 warning).
- `onboarding.test.ts` already asserts the served installer is byte-identical to the repo file.

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** ADR-0003 (outbound agent WS; already allows `wss?://`)
- **Proposed ADR:** None

## Deployment

- **Deploy-affecting:** Yes. The hub serves the modal and `/install-agent.sh`.
- **Artifact invariant:** `GET /install-agent.sh` contains `systemctl restart irori-agent.service`.
- **Functional probe:** the Add-node modal over https shows `wss://`.
- **Rollback:** redeploy the previous `dev-*` tag.

## Validation evidence

- Configuration validation: process-check rules 3/5 clean on touched files. No AGENTS.md, skill, or ADR changes.
- Tests: `pnpm test` passes. web 565, agent 342, server 301 (+181 DB-gated skipped locally; CI runs them), core 123, proxy 24, db 8 (+8 skipped). New `apps/web/test/agent-urls-iri156.test.ts` (5). `onboarding.test.ts` confirms `/install-agent.sh` is served byte-identical to the repo file.
- Installer (no shell test harness in repo): `bash -n` ok; shellcheck not installed. Preflight exercised live from the workstation: `ws://10.0.10.9:3947` → 101 ok; `wss://irori.as267.com` → 101 ok; `ws://irori.as267.com` → 301 warning + `wss://` hint; `ws://10.20.30.9:3947` → unreachable warning; `http://foo` → scheme warning; `wss://example.com` → 404 "proxy not forwarding" warning. Every case continues under `set -euo pipefail`. Restart/wait tail run with stubbed `systemctl`/`journalctl`/`sleep`: calls `daemon-reload`, `enable`, `restart`, then `journalctl --since <START_TS>`. Failing agent → prints `connection error: Unexpected server response: 301` once, rc=1; `handshake ok` → rc=0; silent agent → no error header, rc=1.
- Build: `pnpm typecheck` (runs `pnpm -r build` first) passes.
- Lint: touched files clean. `pnpm lint` reports 72 problems, identical on `main` (pre-existing, out of scope).
- Documentation check: DEPLOYMENT.md (TLS-proxy section, re-run semantics, addresses), CONFIGURATION.md (`IRORI_SERVER_URL` wss note). No other doc describes the old `enable --now` behaviour.

## Review

- Correctness:
  - The restart sequence and every wait/timeout path were exercised with stubbed systemd (cursor, `--since` fallback, journalctl failure).
  - Every preflight branch was run live under `set -euo pipefail`.
  - On real journalctl (systemd 261), `--after-cursor` with the global cursor includes new lines and excludes older ones.
- Security (security-check result): PASS, INFO only.
  - The preflight sends no token and doesn't follow redirects.
  - The error tail prints only hub-supplied `msg` text.
  - URLs come from the operator's own arguments or from `window.location`.
- Data isolation and authorization: no change. There are no new endpoints, and the hub's token check is untouched.
- Compatibility and migrations:
  - No schema or protocol change.
  - LAN `ws://HOST:3947` installs behave as before, plus the preflight line.
  - A re-run now restarts the agent, which interrupts in-flight jobs; this is documented.
- Tests:
  - `agent-urls-iri156.test.ts` (5).
  - Modal mount over https checks for `wss://` (NIT-2).
  - Assertions on the served installer: restart, cursor before restart, no `-2 min`, preflight present (NIT-1).
  - Both new tests were mutation-checked: each fails against the old behaviour.
- Documentation and ADRs:
  - DEPLOYMENT.md: TLS-proxy section, re-run semantics, job interruption, 10.0.10.x topology.
  - CONFIGURATION.md: `IRORI_SERVER_URL` note.
  - No ADR (ADR-0003 already covers `wss?://`).
- Adversarial review: fresh read-only reviewer, verdict **APPROVE**, no BLOCK.
  - WARN-1 (second-precision `--since` window): fixed with a journal cursor; timestamp kept as fallback.
  - NIT-1 / NIT-2 (missing tests): fixed.
  - NIT-3 (restart kills jobs): documented.
  - Unverified pipefail/SIGPIPE on `journalctl | grep -q`: fixed by capturing the log, then matching.
  - NIT-4/5/6: accepted (see limitations).
- Residual risks:
  - The `--since` fallback (no cursor shown) keeps the sub-second window.
  - curl's proxy env vars can make the preflight take a different path from the agent. The preflight is warn-only either way.

## Completion summary

- **Technical decisions:**
  - Restart instead of `enable --now`.
  - Journal cursor (global `-n 1 --show-cursor`) as the cutoff.
  - Warn-only preflight.
  - Scheme helper extracted to `apps/web/src/agent-urls.ts`.
- **Known limitations:**
  - NIT-4: the msg extraction cuts at an escaped quote; no current message has one.
  - NIT-5: a TLS-verify failure shows as "could not reach", and a `--server` missing `/agent-ws` blames the proxy. Both are warn-only.
  - NIT-6: `.env.example`'s `DATABASE_URL` host `10.20.30.5` is a sample placeholder, left unchanged.
- **Deployment notes:**
  - Ships with the next `dev-*` deploy; the hub serves both the modal and `/install-agent.sh`.
  - Agents already installed are unaffected.
  - dgx-4 needed a one-off `systemctl restart irori-agent.service`.
- **Follow-ups:** none required.
