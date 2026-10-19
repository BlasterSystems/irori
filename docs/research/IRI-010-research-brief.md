# IRI-010 research brief — Node management UI (add/edit/delete/rotate)

- **Date:** 2026-10-19
- **Ticket:** IRI-010 (Jira [IR-56](https://blastersystems.atlassian.net/browse/IR-56))
- **Goal:** What exactly must the node-management UI do, which in-repo patterns does it reuse, and where do the mockup's assumptions diverge from the built system?

## 1. What the server already supports

Evidence — `apps/server/src/app.ts`:

- `POST /api/v1/nodes` (:129-151) — zod-validates `nodeCreateSchema`, returns **`201 { node, token }`**. The token is returned exactly here and never again ("Registry entries … never include secrets", `packages/core/src/node.ts:23`).
- `PATCH /api/v1/nodes/:id` (:153-169) — partial; **only keys present in the request body are applied** (comment at :156-158: absent `llmPorts` default `[]` must not wipe stored values).
- `DELETE /api/v1/nodes/:id` (:171-180) — `204`, also `deps.rings.remove(id)`.
- `POST /api/v1/nodes/:id/token/rotate` (:182-189) — `{ token }`.
- No auth on any of these (homelab, ADR-0001/0003).

Schemas — `packages/core/src/node.ts`:

- `NODE_KINDS = ["spark", "gpu-host", "nas"]`, `NODE_ROLES = ["head", "worker", "standalone"]` (:6-7).
- `nodeCreateSchema` = pick(name, kind, role, host, llmPorts, nasRoot) + optional `enabled` (:35-37).
- `nodePatchSchema` = pick(name, kind, role, host, enabled, sortOrder, llmPorts, nasRoot).partial() (:41-43).
- Both types exported from `packages/core/src/index.ts:2` (`export * from "./node.js"`).

## 2. What the mockup prescribes vs what must be adapted

Evidence — `mockups/nodes.html` (approved M0 round):

- Pagehead: "Fleet registry — hot add/edit/remove, no restart." + right-aligned `btn btn--primary` "Add node…" (:26-36).
- Registry table rows carry `Open` / `Edit` / `⋯` ghost `btn--sm` actions (:60).
- "Add node" card fields: Host/IP, **SSH user, SSH port**, install one-liner (`irt_••••`), "waiting for agent hello…" chip, "Install via SSH (stored credentials)" (:88-100).
- First-run card: ghost-grid "no nodes yet" + "add your first spark → register the nas → download a model → serve" (:102-120).
- Claim at :100: "Token rotation pushes config-update to connected agents."

Adaptations required (mockup predates ADR finalization):

- **No SSH install**: ADR-0003 makes the agent a privileged outbound-WS service; SSH is bootstrap/fallback only (SPECSHEET). The wizard shows `install-agent.sh` usage instead — which itself anticipates a server UI: `--token irn_... is required (server UI or POST /api/v1/nodes)` (`apps/agent/install-agent.sh:31`).
- **Tokens are `irn_…`**, not `irt_` (install script :31).
- **Rotation does NOT push live**: `config-update` carries only cadence/llmPorts/llmCadence/nasRoot — no token (`packages/core/src/agent-messages.ts:47-51`, `apps/server/src/hub.ts:91-97`). The token is validated at hello (`helloMsgSchema`, agent-messages.ts:12-13; agent sends it in the hello frame, `apps/agent/src/transport.ts:270-272`). So after rotate: the old token fails at the agent's **next reconnect**; the env file must be updated and the agent restarted. UI copy must say this.

## 3. Overlay pattern to reuse (no second convention)

Evidence:

- ServeView's setup wizard is the in-app overlay precedent: `<div class="drawer-scrim" @click.self="closeWizard"><div class="wizard" role="dialog" aria-modal="true">` with `.card__head`, `.field > label + input.input/.select`, `.banner.banner--warn` errors, footer `btn--primary btn--sm` (`apps/web/src/components/ServeView.vue:648-775`); `.wizard` is scoped style (:812-818) and `.drawer-scrim` scoped (:788-796).
- `apps/web/src/assets/irori.css:258-263` (mobile media block) **already references `body .modal__panel`, `body .backdrop`, `body .wizard`** — but `.backdrop`/`.modal__panel` have no desktop definitions anywhere in the port. Completing those two classes in iroiri.css finishes an anticipated, not invented, DS pattern.
- Uptime-monitoring DS `components/ui/Modal.vue` (focus trap, Escape, scroll-lock, restore focus) is the behavioral reference; Irori keeps global classes + per-view scoped styles, no `ui/` component layer (only CleanupDrawer/ServeView precedents exist).

## 4. How the UI learns about registry changes

Evidence — `apps/web/src/live.ts`:

- No SSE event for registry mutations (`packages/core/src/events.ts`, `apps/server/src/sse.ts`: no registry/node-added matches). SSE carries `snapshot`, `node-online/offline` (which **skip unknown nodes**: "registry is authoritative; next refresh picks it up", live.ts `ingest` case), `heartbeat`, `bench`, llm events.
- The store exposes **`refreshNodes(): Promise<void>`** ("Re-fetch the node registry (used on init and on SSE (re)connect)", live.ts:57-58) — mutations call it, so cards appear/update/disappear without reload.

## 5. Web client + test conventions

Evidence:

- `apps/web/src/api.ts` — plain `fetch` helpers; responses validated with schemas from `@irori/core` (`nodeInfoSchema.safeParse`, api.ts:38) and hand-rolled parsers where zod is unavailable (llm, :267-282). No node mutation helpers exist yet.
- `apps/web/test/api.test.ts` — vitest, `vi.stubGlobal("fetch", mockFetch(status, body))`, `VALID_NODE` fixture, one `describe` per function, error-path tests (HTTP 500, shape errors). Node environment, pure-function tests; no component-mount tests in this app.
- Web deps: `@irori/core` workspace + vue only (package.json) — zod reaches the client through core's exports.

## Summary of Findings

1. Build the UI on the existing endpoints; no server changes needed. `POST`'s one-time token is the only secret surface.
2. Adapt the mockup: drop SSH install/`irt_`; use `install-agent.sh --server ws://HOST:PORT/agent-ws --token irn_…` + `/etc/irori/agent.env` env names (`IRORI_SERVER_URL`, `IRORI_NODE_TOKEN` — `apps/agent/src/config.ts:37-51`).
3. Rotation copy: old token dies at next reconnect; update env + restart the agent. Never claim a live push.
4. Reuse `.drawer-scrim` overlay markup; add the missing `.backdrop`/`.modal__panel` desktop classes to iroiri.css (mobile rules already expect them).
5. After every mutation call `live.refreshNodes()`; no server-side registry broadcast exists.
6. Follow api.test.ts's `mockFetch` pattern; keep request building in a pure, tested helper.

Open: none blocking. The DS oracle file (`Design System.dc.html`) was not located in this repo; the ADR-0005 token port + ServeView/CleanupDrawer precedents are treated as authoritative for component styling.
