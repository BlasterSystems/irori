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

- [ ] Implement view changes
- [ ] Validate (pnpm build, .agentic/bin/validate, docs-check)
- [ ] Fixture-browser verification (vite + init_scripts mock)
- [ ] PR + evidence comment

## Architecture impact

- **ADR required:** No — web-local UI behavior over existing endpoints; no data, deployment, or integration boundary changes.
- **Relevant ADRs:** ADR 0008 (capture proxy) — unaffected.
- **Proposed ADR:** None

## Review
