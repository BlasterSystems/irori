# Task: Setup wizard — config name + save without starting (IR-76)

## Objective

Let the user name a serving config and persist one without launching it. Today a
start-time failure (e.g. `MODEL_PATH resolution failed … (modelctl path --local)`)
surfaces as a bare wizard error even though the setup row was already created —
the saved config is invisible to the user.

## Acceptance criteria

- [ ] Step 1 (TYPE) has a Config name input (optional; empty falls back to the model name); edit/duplicate prefill it.
- [ ] Review step shows a name row with the resolved name.
- [ ] Step 5 offers "Save without starting" (secondary, new setups only): create (or patch for edits) without start, then close + reload — regardless of start-time env resolution.
- [ ] If start fails after a successful create, the banner reads "Setup saved — start failed: <err>"; retrying Create & start reuses the created row (no duplicate POST).
- [ ] No API/DB/migration changes; build + validate green; fixture-browser verification of both paths.

## Scope

### Included

- `apps/web/src/components/ServeView.vue`: wizard markup (name input, review row, footer button) + `onSaveOnly` + honest start-failure banner.

### Excluded

- Server/agent changes, migrations, name uniqueness constraints (duplicates allowed).

## Plan

- [x] Implement view changes
- [x] Validate (pnpm build, .agentic/bin/validate, docs-check)
- [x] Fixture-browser verification (vite + init_scripts mock)
- [x] PR + evidence comment

## Architecture impact

- **ADR required:** No — web-local UI behavior over existing endpoints; no data, deployment, or integration boundary changes.
- **Relevant ADRs:** ADR 0008 (capture proxy) — unaffected.
- **Proposed ADR:** None

## Validation evidence

- Build: `pnpm --filter @irori/web build` — vue-tsc clean, vite bundle 409 kB.
- Tests: `pnpm --filter @irori/web test` — 21 files, 211/211 green.
- Configuration validation: `.agentic/bin/validate` — passed, exit 0.
- Documentation check: `.agentic/bin/docs-check --base origin/main --strict` — exit 0.
- Fixture browser verification (built dist + `window.fetch` mock + fake EventSource, Chromium):
  - Review step renders the `name` row (`glm tp3`) and footer `Back / Save without starting / Create & start`.
  - Save-only: exactly one `POST /api/v1/setups`, zero `/start`, wizard closed, card rendered.
  - Failed start (mocked 500 `MODEL_PATH resolution failed for … (modelctl path --local)`): banner `Setup saved — start failed: …`; retry without edits reuses the row (POST stays 1, start 2); Save-without-starting then closes with no further POST/DELETE.
  - Edit-then-retry: `DELETE` + fresh `POST` carrying the edited name (no fork), banner re-shown.
  - Zero app console errors (sole pageerror was the driver's own malformed XPath probe). Light-theme screenshots captured; dark theme token-driven.

## Review

- Round: 2 sequential reviewer agents (VueView, CoreLogic) on PR #32.
- VueView: contract points verified correct (name fallback/persistence, footer v-if/v-else pairing, createdInput reset coverage, delete status semantics, DS markup). One P2 fixed on the branch (1fff56f): the replace path now cancels a running staged transfer before deleting the row — the delete cascades `setup_transfers`, which would otherwise strand live node download jobs behind a phantom transfer handle.
- CoreLogic: all common paths verified correct (payload/status-code shapes, banner wording vs failure origin, busy/finally, double-click guards, snapshot semantics). Two accepted-as-followup findings — both PRE-EXISTING server semantics reachable without this PR (per-card delete, wizard Cancel button): ack-timeout starts can orphan a live engine behind a deletable `failed` row, and inter-stage transfer cancel no-ops. Filed as IR-77 (backend, sprint 985); deliberately out of this frontend-only ticket.
- Residual risks: snapshot compare is JSON-key-order sensitive by design (same builder both sides — no false negatives; benign false positives only when the rendered payload is identical). The inter-stage-gap cancel race is documented in IR-77.

## Closeout

- PR #32 rebase-merged; deployed by the next dev-* tag (see validation on IR-76).
