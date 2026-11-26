# Research: agent install fails behind the TLS reverse proxy (irori.as267.com)

## Tracker target

Jira project **IR**: story **IR-270** (IRI-156), created 2026-11-26. Resolved from the memory note and recent commit subjects (`IR-269 / IRI-155`).

## Summary

`install-agent.sh --server ws://irori.as267.com/agent-ws …` on dgx-4 never logs `handshake ok`. Two independent faults, both reproduced from the workstation on 2026-11-26:

1. **Wrong scheme.** `ws://irori.as267.com/agent-ws` hits openresty on :80, which answers `301 → https://…/agent-ws`. WebSocket clients do not follow redirects, so the agent loops on `connection error: Unexpected server response: 301`. The command came from the Add-node modal, which hard-codes `ws://` regardless of page protocol.
2. **Proxy strips the upgrade.** `wss://irori.as267.com/agent-ws` (HTTP/1.1, valid upgrade headers) returns **404 from Express** (`X-Powered-By: Express`). If `Upgrade`/`Connection` reached Node, `server.on("upgrade")` would have taken the socket before Express ran; the 404 proves the proxy host for irori.as267.com has no WebSocket passthrough. So even with `wss://`, the agent would fail with `Unexpected server response: 404`.

Fix #2 is an ops change (no code). Fix #1 plus better diagnostics is a small code ticket.

**Update 2026-11-26 18:51 — actual blocker was a third, installer bug.** Re-runs with `wss://irori.as267.com` and `ws://10.0.10.9:3947` still failed. On dgx-4, `systemctl status` showed the unit `active (running) since 17:44:17`, the first install, and the journal still showed `Unexpected server response: 301` every 30 s. `install-agent.sh` rewrites `/etc/irori/agent.env` and the bundle, then calls `systemctl enable --now` (`apps/agent/install-agent.sh:99`). That is a no-op for an already-running unit, so **a re-run never applies the new server URL, token, or bundle**. The hub log (container `irori-dev`, LXC 106) confirmed it: no `rejected agent` lines and nothing from 10.0.10.7 in 2 h. Workaround: `systemctl restart irori-agent.service`.

## Current state (evidence)

- Modal URL: `apps/web/src/components/NodeModal.vue:45-47` — `` `ws://${location.host}/agent-ws` `` while the HTTP base on `:50-52` correctly uses `location.protocol`. Mismatch: an https page yields an `https://` curl base and a `ws://` agent URL.
- Hub upgrade handler: `apps/server/src/hub.ts:556-565` (only `pathname === "/agent-ws"` upgrades; non-upgrade requests fall through to Express).
- SPA fallback deliberately skips `/agent-ws` → final JSON/HTML 404: `apps/server/src/app.ts:2324-2330`.
- Agent logs the raw ws error: `apps/agent/src/transport.ts:373-374`; reconnect loop `:605`.
- Installer waits 60 s for `handshake ok` and only points at journalctl, never shows the last error: `apps/agent/install-agent.sh:102-113`.
- Agent self-update already maps `wss://` → `https://` correctly: `apps/agent/src/jobs.ts:30-36` (no change needed).
- Docs show only plain `ws://HOST:3947` and say nothing about TLS proxies / WebSocket passthrough: `docs/DEPLOYMENT.md:120-142`.
- Live probes (2026-11-26):
  - `http://irori.as267.com/agent-ws` + upgrade headers → `301 Location: https://irori.as267.com/agent-ws` (openresty).
  - `https://irori.as267.com/agent-ws` (`--http1.1`) + upgrade headers → `404`, `X-Powered-By: Express`.

## Gap analysis

| Gap | Kind |
|---|---|
| Proxy host lacks WS upgrade forwarding | Ops (proxy config) |
| Modal emits `ws://` on https pages | Bug |
| Installer accepts `ws://` without a preflight, hides the actual error | UX/diagnostics |
| DEPLOYMENT.md has no reverse-proxy section | Docs |

## Proposed design

**Ops (do now, no ticket required):** enable WebSocket support on the openresty proxy host for irori.as267.com (Nginx Proxy Manager: "Websockets Support" toggle; raw nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout ≥ 3600s` on `location /agent-ws`). Then re-run the installer with `--server wss://irori.as267.com/agent-ws`.

**Code (one story):**
1. `NodeModal.vue`: derive the scheme from `location.protocol` (`https:` → `wss:`); unit test both branches.
2. `install-agent.sh`: on timeout, print the last ~5 `irori-agent` journal lines (filtered to `connection error|server error|disconnected`) so 301/404/401 are visible immediately. Optional preflight: `curl --http1.1` upgrade probe against the derived https/http base, warn on 3xx ("use wss://") and on a non-101 response ("proxy is not forwarding WebSocket upgrades").
3. `docs/DEPLOYMENT.md`: "Behind a TLS reverse proxy" subsection — wss URL, required nginx directives, the 301/404 symptoms.

Rejected alternatives:
- *Make the agent follow redirects* (`followRedirects` in `ws`): masks misconfig, silently downgrades/upgrades schemes; a 301 to https would still fail on the stripped-upgrade proxy.
- *Auto-rewrite `ws://` → `wss://` in the agent*: guesses, breaks plain-LAN `:3947` installs.

No ADR needed (no boundary/contract change; ADR-0003 already allows `wss?://`).

## Phased delivery plan

- **Phase 0 (ops, now) — DONE 2026-11-26 18:34:** NPM "Websockets Support" enabled; `wss://` probe now returns `101 Switching Protocols`. Remaining blocker on dgx-4 is the `ws://` scheme in the copied command.
- **Phase 0 detail:** proxy WS passthrough + reinstall with `wss://`. Acceptance: `curl --http1.1` upgrade probe to `https://irori.as267.com/agent-ws` returns `101` (or 401 with a bad key — anything from `ws`, not Express 404); dgx-4 logs `handshake ok`.
- **Story IR-270 / IRI-156 — "Agent install works behind a TLS proxy"** (single ticket):
  - AC0 (highest priority): the installer restarts the unit (`systemctl enable irori-agent.service && systemctl restart irori-agent.service`), so a re-run applies the new env and bundle. The `handshake ok` wait greps only journal lines from after that restart (e.g. `--since` a timestamp captured just before it), not `-2 min`, so a stale success line from an earlier run can't fake a pass.
  - AC1: Modal served over https shows `--server wss://<host>/agent-ws`; over http shows `ws://`. Test added.
  - AC2: Installer timeout output includes the agent's last connection error line.
  - AC3 (optional): installer preflight warns on 3xx / non-upgrade response before enabling the unit.
  - AC4: DEPLOYMENT.md documents TLS-proxy setup and the two symptoms.
  - Deploy-affecting: web + install script are served by the hub → ships with the next server image.

## Risks and open questions

- Is the proxy Nginx Proxy Manager (openresty `Server` header suggests so) or hand-written nginx? Default: NPM, toggle "Websockets Support".
- Should the preflight be blocking (exit 2) or warn-only? Default: warn-only — LAN installs to `:3947` must keep working.
- The DGX-4 node token was pasted into a chat transcript — rotate it after the node enrolls (Nodes → Rotate token).
- `[INFERENCE]` Exact agent journal line on dgx-4 not observed; expected `connection error: Unexpected server response: 301`.

## Overlap findings

JQL `project = IR AND statusCategory != Done AND text ~ (wss|websocket|reverse proxy|install-agent|TLS)` → only IR-269 (unrelated). No existing tracker overlap. Related prior research: `tasks/research-agent-ws-oversized-frame-crash-loop.md` (different failure, post-handshake).
