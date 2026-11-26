# fix/iri-156-agent-install-restart (IR-270 / IRI-156)

## Business context

Onboarding dgx-4 against the dev hub published at `https://irori.as267.com` failed for over an hour. Each attempt ended in a silent 60 s timeout. The operator fixed the URL and re-ran the installer several times, but nothing changed. Re-running the copied command should be all it takes to fix a bad agent install, and a failure should say why.

## What changed

- **Installer re-runs take effect.**
  - `install-agent.sh` now runs `systemctl enable` and then `systemctl restart`.
  - `enable --now` left an already-running agent on its old URL and token.
- **Success is judged only on post-restart log lines.** The installer takes a journal cursor just before the restart; a stale `handshake ok` from an earlier run no longer counts.
- **Failures explain themselves.**
  - On timeout the installer prints the agent's last `connection error` / `server error` messages, e.g. `Unexpected server response: 301`.
  - A warn-only preflight probes the WebSocket path before starting. It warns about a redirect (and suggests `wss://`), a proxy that doesn't forward upgrades, or an unreachable hub.
- **The Add-node modal hands out the right scheme.** On an https page the install command uses `wss://`, and on http it stays `ws://`.
- **Docs.**
  - DEPLOYMENT.md has a "Behind a TLS reverse proxy" section and corrected dev topology addresses (10.0.10.x).
  - CONFIGURATION.md notes `wss://` for `IRORI_SERVER_URL`.

## Business rules and constraints

- The preflight never blocks: LAN `ws://HOST:3947` installs and a hub that isn't up yet must still install.
- The preflight never sends the node token.
- Re-running the installer restarts the agent, which interrupts jobs running on that node. Re-run on an idle node.

## Edge cases handled

- `--server` already `wss://` with a redirect: the warning appears without a hint, and the script doesn't abort under `set -e`.
- No journal cursor available: falls back to a second-precision timestamp.
- journalctl unavailable or failing: clean timeout, no crash.
- Pino JSON log lines: the `msg` text is extracted and repeated retries are collapsed.

## Integration impact

- The hub serves both the modal and `/install-agent.sh`, so the change ships with the next `dev-*` deploy.
- Agents already installed are unaffected.
- No protocol, schema, or API change.

## Out of scope and follow-ups

- Making the agent follow redirects or auto-upgrading `ws://` to `wss://` was rejected; it would hide misconfiguration.
- Known warn-only imprecision: a TLS-verify failure is reported as "could not reach".

## Verification

- `pnpm typecheck` ok.
- `pnpm test`: web 566, agent 342, server 302 (+181 DB-gated skipped), all green.
- New tests:
  - `agent-urls-iri156.test.ts`;
  - modal https mount test;
  - served-installer assertions in `onboarding.test.ts`.
  - Both behaviour tests were mutation-checked: each fails against the old code.
- Installer: `bash -n`.
- Live preflight against the dev hub: direct ws → 101; wss via proxy → 101; ws via proxy → 301 warning with hint; old address → unreachable warning.
- Stubbed-systemd runs of the restart and wait paths.
- Real-journalctl check that `--after-cursor` excludes older lines.
- Independent adversarial review: APPROVE, no BLOCK; WARN-1 and NIT-1/2/3 addressed.

## Changelog

- 2026-11-26: Installer restarts the unit and reads post-restart journal lines by cursor, with a warn-only WebSocket preflight and an error tail on timeout. The modal emits `wss://` on https pages. DEPLOYMENT.md has a TLS-proxy section and topology fixes.
