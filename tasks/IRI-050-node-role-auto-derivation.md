# Task: IRI-050 — Auto node-role adjustment (head/worker/standalone) from serving-setup membership

Jira epic **IR-135**, children **IR-136** (S1 derivation contract), **IR-137** (S2 wiring), **IR-138** (S3 node-delete hygiene), **IR-139** (S4 web copy + docs). Research brief: `docs/research/IRI-050-node-role-auto-derivation-research-brief.md`. All in sprint 990. Option A approved 2026-10-30 (manual override preserved; overwritten at next membership change). No ADR required (no schema/deployment/dependency change).

## Objective

When a model is configured to run on multiple nodes (a serving setup), node roles adjust automatically instead of being hand-maintained in the node modal. Role's only functional consumer is the agent probe config: `worker` → `llmCadenceMs: 10_000` + `llmDetectOnly: true` (`hub.ts:139-141`); everything else is display sugar that already reacts to role.

## Acceptance criteria (per ticket)

**IR-136 (S1)**
- [x] Pure `deriveNodeRoles(setups, nodeIds)` in `packages/core/src/node.ts` — head if headNodeId of any setup, else worker if in any worker list, else standalone; dangling ids (not in `nodeIds`) ignored; idempotent; reuses `NodeRole`/`NODE_ROLES`, no new enum values.
- [x] `diffNodeRoles(derived, current, scope?)` — emits only changed roles; `scope` limits writes to the caller's affected set (manual overrides outside it are preserved).
- [x] Unit tests in `packages/core/test/node.test.ts`: head>worker precedence, dangling ignored, idempotent, diff emits only changes.

**IR-137 (S2)**
- [x] `create()`: derive for head + workers after insert, **before** `ensurePortAssigned` (G7 ordering — its config-update carries the new role).
- [x] `patch()`: when `patch.nodes` present, derive for old ∪ new members + head, before the port-change push.
- [x] `remove()`: derive for the removed row's head + workers after delete.
- [x] Per changed node: role write + `refreshNodeConfig` (offline → `false`, harmless; reconnect re-derives via hello).
- [x] Real-WS pin in `apps/server/test/llm.test.ts` (db-integration describe): after `create()`, the worker agent's pushed `config-update` carries `llmCadenceMs: 10_000` + `llmDetectOnly: true`; the head's first push carries `llmDetectOnly: false` even when the head previously had role `worker` (ordering pin).
- [x] Service tests in `apps/server/test/setups.test.ts`: create/patch/remove role flips both ways; multi-membership head-over-worker precedence; manual role PATCH survives unrelated setup ops.

**IR-138 (S3)**
- [x] `NodeStore.remove` strips the deleted id from every `setups.nodes` jsonb array and bumps `updatedAt`, in one transaction with the delete (the FK only cascades `headNodeId`).
- [x] Tests: delete worker of one setup (strip), delete head of another (cascade, setup gone), delete node absent from all setups (no-op); surviving setups parse through `setupNodeSchema` (service `get` round-trip).

**IR-139 (S4)**
- [x] `NodeModal.vue` role field helper text (create + edit modes).
- [x] `docs/API.md` Nodes section: derivation rule + override semantics.
- [x] One-line pointer from the research brief to the API note. `.agentic/bin/docs-check` green.

## Plan

1. S1 `packages/core/src/node.ts`: `SetupMembership`, `deriveNodeRoles`, `diffNodeRoles` + tests.
2. S2 `apps/server/src/setups-service.ts`: private `applyDerivedRoles(affected)` — read all setups + nodes, derive, write-only diff scoped to `affected`, `refreshNodeConfig` per change. Hook create/patch/remove. Tests (service + wire).
3. S3 `packages/db/src/store.ts`: `remove()` transaction adds the jsonb strip. Tests.
4. S4 `apps/web/src/components/NodeModal.vue` + `docs/API.md` + brief pointer.
5. Validate: `pnpm test`, `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check`.

## Decisions

- Option A (approved): derivation on membership events, manual override preserved until that node's membership changes. Option B (fully derived) rejected — it would break head-marking of non-setup engines (DGX-1 tensorfold :8081).
- `diffNodeRoles` takes an optional `scope` set so S2 writes ONLY the affected subset — a full-scope diff would demote manual heads of unrelated nodes on every setup op.
- Role writes live in `setups-service` (it already owns `refreshNodeConfig` + db access); the jsonb strip lives in the node store (`packages/db`) — repository-level, same transaction as the delete.
- No schema change, no agent change, no new UI vocabulary. `ensureFreshCreated` (wizard delete+recreate) needs no code — it composes create+remove.

## Residual risks / limitations

- No backfill: existing rows are rewritten only at their next membership event (approved — avoids surprising overwrites).
- Workers of a **cascade-deleted** setup (node that headed it was deleted) keep their stale `worker` role until their next membership event — the brief's S3 scope is strip-only; derivation tolerates dangling ids. Flagged to the epic, not silently fixed.
- NAS-as-head stays possible (pre-existing wizard behavior); derivation labels such a NAS `head`.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — "Configuration validation passed".
- Tests: `IRORI_TEST_DATABASE_URL=… pnpm -r test` (disposable `irori-test-pg` on :54329) — core 99, server 224 (incl. 5 new role-derivation/hygiene tests + the real-WS cadence pin in `llm.test.ts`), web 275, db 5, agent 196, proxy 23 — all green.
- Build: `pnpm build` green (all packages incl. web vite build).
- Documentation check: `.agentic/bin/docs-check` — "No heuristic documentation gaps detected".
- UI: static-fixture browser check of the built dist — helper text present and visible in NodeModal create AND edit modes; a first render exposed a DS row-stretch bug (Kind select pushed to the row bottom), fixed with `align-content: start` on `.field` (`apps/web/src/assets/irori.css`), re-verified aligned (`kindSelectTop == roleSelectTop`) plus a no-regression probe of the BenchmarksView `.cols-4` field row.

## Review

- Correctness: derivation is pure and scoped — only the affected setup's members are written, so manual overrides of unrelated nodes survive (pinned by "manual role override survives unrelated setup ops"). G7 ordering pinned over a real WS: a head that previously had role `worker` receives `llmDetectOnly: false` on its FIRST post-create push. `deriveNodeRoles` ignores dangling ids (unit-tested) — belt-and-braces against pre-hygiene jsonb.
- Security: no new routes; drizzle parameterized queries only; no secrets logged.
- Compatibility: no API contract change; `role` semantics only. No agent change, no migration.
- Residual risks: workers of a cascade-deleted setup (their head node was deleted) keep a stale `worker` role until their next membership event — S3 is strip-only per ticket; flagged to the epic. No backfill of existing rows (approved).
