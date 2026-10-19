# Task: IRI-010 — Node management UI (add/edit/delete/rotate)

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) post-M8) · Jira: [IR-56](https://blastersystems.atlassian.net/browse/IR-56) · Research: [IRI-010 research brief](../docs/research/IRI-010-research-brief.md)

## Objective

Port the approved mockup's node management (`mockups/nodes.html`) to the Vue
app: add a node from the Overview fleet page, edit/delete/rotate-token from
the node detail page, with the one-time agent token surfaced safely. The
server API is complete (POST/PATCH/DELETE/token-rotate) — this task is
web-only plus the two missing DS overlay classes.

## Acceptance criteria

- [ ] `apps/web/src/api.ts`: `createNode` / `patchNode` / `deleteNode` /
      `rotateNodeToken` typed with `NodeCreateInput` / `NodePatchInput`.
- [ ] "Add node…" button on Overview (pagehead) opens a modal
      (name/kind/role/host/llmPorts/nasRoot); success shows the token once
      with copy + `install-agent.sh` / env instructions.
- [ ] NodeDetail: Edit (same modal, prefilled), Rotate token (confirm →
      new token shown once, with reconnect warning), Delete (armed
      two-click confirm, ServeView pattern).
- [ ] Registry refreshes via `live.refreshNodes()` after every mutation —
      no reload needed; empty state gets the mockup's first-run ghost.
- [ ] `.backdrop` / `.modal__panel` desktop classes added to iroiri.css
      (mobile rules already reference them at :258-262).
- [ ] Unit tests: client fns (api.test.ts pattern) + pure form helpers.
- [ ] validate + typecheck + test + build + docs-check green; browser
      smoke add→edit→rotate→delete against a throwaway server+DB.

## Scope

### Included

- Web client + UI + DS css completion; docs touchpoints (API.md UI note if
  any, task evidence).

### Excluded

- Server changes (endpoints complete); SSH-based install (ADR-0003);
  registry-change SSE broadcast (refreshNodes suffices for homelab scale);
  the "Nodes" nav item stays an active-state indicator per M0 decision.

## Plan

- [x] Research: [IRI-010 brief](../docs/research/IRI-010-research-brief.md) — mockup vs ADR divergence, overlay pattern, refresh path, API contract
- [x] Implement api.ts client functions
- [x] NodeModal component (create/edit/rotate-token reveal) + Overview button + empty state
- [x] NodeDetail actions (edit/rotate/delete)
- [x] Tests (api + node-form + clipboard helpers)
- [x] Validate: typecheck/test/build + .agentic/bin/validate + docs-check
- [x] Browser smoke on throwaway server+DB

## Architecture impact

- **ADR required:** No (local UI feature; no data/deployment/integration change)
- **Relevant ADRs:** ADR-0003 (privileged agent, outbound WS — rotation semantics), ADR-0005 (DS Vue port)
- **Proposed ADR:** None

## Validation evidence

- Configuration validation: `.agentic/bin/validate` → "Configuration validation passed"
- Tests: workspace `pnpm test` green — web 136/136 (22 api incl. 11 new mutation
  tests, node-form 7, clipboard 3, ds-markup guard updated to the new empty
  state), server 46 passed / 38 DB-skipped, core+agent green
- Build: `pnpm typecheck` + `pnpm build` green (web dist 308.51 kB js)
- Documentation check: `.agentic/bin/docs-check` warnings cleared after
  SPEC §3 / API.md / ARCHITECTURE.md updates
- Browser smoke (throwaway server :3999 + scratch pg `irori_ui_smoke`, since
  dropped): empty-state ghost → Add node modal → create → one-time token
  reveal (env block + install line) → card appears **without reload** →
  drill-down Edit (prefilled, rename saved live) → Rotate token (new token +
  reconnect warning) → armed two-click Delete → back to empty fleet, API `[]`

## Review

- Correctness: mutations reuse the existing endpoints; PATCH sends the full
  desired form state (server applies present keys); refreshNodes() after every
  mutation keeps cards current without SSE registry events
- Security: token revealed once, never re-fetched, in a readonly input; no
  secrets in the registry DTO path; no auth weakened
- Compatibility: `NodeCreateInput`/`NodePatchInput` (z.infer, @irori/db store
  contract) untouched — new `NodeCreatePayload`/`NodePatchPayload` (z.input)
  added alongside; ds-markup guard updated with the intended markup change
- Residual risks: token Copy button depends on the async clipboard API
  (graceful `copied` fallback, false on denial); mobile full-screen behavior
  for `.modal__panel` relies on the pre-existing `body`-prefixed rules in
  iroiri.css (same heritage as `.drawer`/`.wizard`)
