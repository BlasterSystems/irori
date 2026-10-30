# IRI-050 research brief — Auto node-role adjustment from serving-setup membership

- **Date:** 2026-10-30
- **Ticket:** IRI-050
- **Jira epic:** [IR-135](https://blastersystems.atlassian.net/browse/IR-135) — epic + 4 child stories (IR-136 S1, IR-137 S2, IR-138 S3, IR-139 S4), created 2026-10-30 after human validation; all in sprint 990; brief attached to the epic + evidence comment 25677. Approved decisions: Option A (manual override preserved), no head-swap scope, epic+4 stories over single ticket.
- **Goal:** When a model is configured to run on multiple nodes (a serving setup), the node roles — `head`, `worker`, `standalone` — should adjust automatically instead of being hand-maintained per node in the node modal.

Ask (owner, verbatim): "when I configure and run a model in multiple nodes, the system should adjust the node type automatically (head, worker, standalone)". "Node type" here is the existing **role** field (`head|worker|standalone`), not `kind` (`spark|gpu-host|nas`), which stays manual.

---

## 1. Current state (evidence)

### 1.1 Role already exists end-to-end

- Contract: `NODE_ROLES = ["head", "worker", "standalone"]`, `packages/core/src/node.ts:4-7`; required in `nodeCreateSchema`, optional-partial in `nodePatchSchema` (`node.ts:41-48`).
- DB: `nodes.role` enum column, NOT NULL, no default (`packages/db/src/schema.ts:35`; enum created in `packages/db/drizzle/0000_medical_landau.sql:2`). Writers: `packages/db/src/store.ts:66-71` (create) and `:58-70` (patch spread). No later migration touches it.
- Manual surface: role select in `apps/web/src/components/NodeModal.vue:177-181` (free choice, no guard), options/default in `apps/web/src/node-form.ts:5,21` (default `standalone`).

### 1.2 Role's only functional consumer: agent probe config

- `apps/server/src/hub.ts:139-141` — `config-update` derives from the DB row: `llmCadenceMs: row?.role === "worker" ? LLM_DETECT_CADENCE_MS (10_000) : LLM_PROBE_CADENCE_MS (2_000)` and `llmDetectOnly: row?.role === "worker"` (`hub.ts:50-52`). Workers probe detection-only; head **and standalone** probe fully.
- Live propagation already works with zero new wire surface: `role` ∈ `AGENT_CONFIG_KEYS` (`apps/server/src/app.ts:96-97`); a `PATCH /api/v1/nodes/:id` that changes role triggers `hub.refreshConfig(id)` (`app.ts:390-395`, IRI-034 pattern); the agent re-arms its probe timer in place (`apps/agent/src/transport.ts:465-497, 527-533`). The role literal never reaches the agent (`packages/core/src/agent-messages.ts:55-88`); only cadence + detect-only do. On reconnect, `hello` → `config-update` re-derives everything (`hub.ts:268-273`).
- Services can already push configs: `refreshNodeConfig` is an AppDep (`apps/server/src/index.ts:277-278`) and `setups-service` already calls it — via `ensurePortAssigned` (`apps/server/src/setups-service.ts:354-365`), the **only** node-row write in the whole setup lifecycle.

### 1.3 Role's remaining consumers are display/UX sugar

| Consumer | Site | Uses role how |
|---|---|---|
| Card chip | `NodeCard.vue:26`, `NodeDetail.vue:611` | accent chip when ≠ standalone |
| Inference line | `apps/web/src/card-data.ts:166-176` | rendered **only when `role === "head"`** |
| Detect-only panel | `NodeDetail.vue:145-146` | `detectOnly = role === "worker"` |
| Placement tables | `ModelsView.vue:938,943`, `ServeView.vue:818` | "Role" column chip (DTO: `app.ts:955-963`) |
| Wizard default head | `ServeView.vue:333-336` | `firstHeadId()` prefers online `role==="head"` |
| Grouping helper | `apps/web/src/llm-data.ts:161-181` | role-based buckets — **only importers are tests** |
| Analytics | `apps/server/src/analytics.ts:52-92` | does **not** use role; "standalone" pseudo-group folds by **setup membership** |
| Placement engine | `packages/core/src/catalog.ts:63, 76-118` | carries `role`, `planPlacement` never branches on it |

Consequence: mis-set roles are mostly cosmetic today **except** probe cadence/detect-only — a hand-labeled "worker" probes at 10 s detect-only, a hand-labeled "head" of a non-head node gates the card inference line.

### 1.4 Setup membership shape

- `setups.headNodeId` FK → `nodes.id` (`onDelete: cascade`, `packages/db/src/schema.ts:328-330`); workers are a **jsonb array** `[{nodeId, role:"worker"}]` (`schema.ts:331-332`), parsed by `setupNodeSchema` where the per-row `role` is a literal `"worker"` unrelated to `nodes.role` (`packages/core/src/setups.ts:33-37`); ≤ 7 workers (`MAX_SETUP_NODES`, `setups.ts:39,52,77,91`).
- Validation `validateWorkers` (`setups-service.ts:333-352`): rejects duplicate workers, head-as-own-worker, unknown nodes, **NAS-kind workers**. It never reads or writes `nodes.role`.
- Wizard: head select lists **all nodes, any kind, offline included** (`ServeView.vue:748-761`); worker checkboxes filter `id !== head && kind !== 'nas'` (`:759-761`); `sanitizeWorkerIds` dedupes/drops NAS+unknown on edit/duplicate (`apps/web/src/serve.ts:189-200`).
- Membership changes flow through exactly three service ops — `create()` (`setups-service.ts:406-428`), `patch()` (`:431-450`, **no status guard: editable while running**), `remove()` (`:453-460`, refused while starting/running/stopping) — plus the wizard's delete+recreate churn `ensureFreshCreated()` (`ServeView.vue:505-522`, calls `deleteSetup` + `createSetup`, so it inherits whatever create/remove do).
- **Multi-membership is legal today**: nothing prevents a node being head of setup A and worker of setup B (head column non-unique, jsonb workers no FK/uniqueness; `validateWorkers` checks uniqueness only within one setup).

---

## 2. Gap analysis — membership changes that leave role stale

| # | Event | Role damage |
|---|---|---|
| G1 | `create()` adds head + workers | Head keeps old role (often `standalone`) → card inference line missing, `firstHeadId()` misses it; fresh workers keep `standalone` → they probe at 2 s full-rate although they are orchestrated workers |
| G2 | `patch()` adds/removes workers | Added workers: no detect-only cadence. Removed workers: ghost `worker` chip + stale 10 s detect-only probing |
| G3 | `remove()` deletes a stopped setup | All freed members keep their setup-era roles forever |
| G4 | Wizard `ensureFreshCreated()` delete+recreate | Double membership churn per input change; only converges if G1/G3 are fixed |
| G5 | Node delete (`app.ts:401-409`) | Cascades setups the node **heads** but leaves its id **dangling in other setups' workers jsonb** — poison for any derivation reading membership; setup cards render dead "worker · joined" rows |
| G6 | Manual role PATCH vs membership | Role and membership can disagree in both directions; nothing reconciles |
| G7 | `ensurePortAssigned` fires `refreshNodeConfig` **before** any role fix would land | The pushed config-update carries the stale role-derived cadence — ordering matters for the fix |

The ask maps to G1–G4 (the "configure and run in multiple nodes" path). G5 is adjacent hygiene that derivation needs for correctness; G6 is the policy decision below.

---

## 3. Proposed design

### Decision (Option A): derive on membership events, keep manual override

A pure derivation function computes each existing node's role from **all** setups, and the server applies it (write-only-diffs) after every membership-changing setup op. Manual role editing stays; it is simply overwritten the next time that node's membership changes.

```ts
// packages/core (pure, no I/O): nodeId → role over the current setup set
deriveNodeRoles(setups: Array<{ headNodeId: string; nodes: Array<{ nodeId: string }> }>,
                nodeIds: ReadonlySet<string>): Map<string, NodeRole>
```

Rules:
1. **head** if the node is `headNodeId` of any setup; else **worker** if it appears in any setup's worker list; else **standalone**. Precedence head > worker resolves multi-membership (legal today, §1.4).
2. Worker ids not in `nodeIds` (dangling, G5) are ignored.
3. Kind plays no part: NAS nodes can never be workers (validation, §1.4) so they end up head-or-standalone; a NAS head is legal today and stays `head`.
4. Server applies the diff: `store.patch(id, { role })` only where `role` differs, then `deps.refreshNodeConfig(id)` per **changed** node (offline → `false`, harmless; reconnect re-derives, §1.2).

Wiring (all inside `apps/server/src/setups-service.ts` except noted):

- `create()`: after insert, **before** `ensurePortAssigned` (fixes G7 ordering so the refresh pushes the new role) → affected = head + workers.
- `patch()`: when `patch.nodes` present → affected = old members ∪ new members ∪ head (fixes G2 both directions).
- `remove()`: after delete → affected = removed row's head + workers (fixes G3).
- G4 (`ensureFreshCreated`) needs no code — it composes create+delete.
- Role writes land even for offline nodes (DB truth), so no reconnect gaps.

### Rejected alternatives

- **Option B — fully derived role (drop manual editing):** role becomes a computed property; `nodePatchSchema`/`NodeModal` lose `role`. Cleanest single source of truth, but removes the escape hatch that today lets a user mark a **non-setup** node as head — which feeds `firstHeadId()` (`ServeView.vue:334`) and the card inference-line gate (`card-data.ts:174`) for engines Irori doesn't orchestrate (e.g. the DGX-1 tensorfold engine on :8081). Breaking API field removal for marginal invariant gain. Revisit only if the owner wants single-source-of-truth later.
- **Option C — manual "reconcile roles" button on setup save:** doesn't satisfy the ask (still manual), extra UI surface for nothing.
- **Deriving on start/stop instead of configure:** roles would flap with engine lifecycle; membership persists across stop/edit/relaunch, so configure-time is the stable truth. Start/stop also can't fix G2 (membership edits don't restart).

### No schema, no agent change

`nodes.role` column and the `config-update` wire contract are unchanged (§1.1–1.2). Web UI already renders every derived state (chips, detect-only, inference line) — no new vocabulary. Rollout is a server deploy (+ tiny web copy change); no agent rollout; rollback = previous tag, and derived roles that persist are consistent-with-membership by construction.

### ADR check

No ADR recommended: no schema/deployment/dependency/integration change, cheaply reversible behavior convention documented here + task file. **Revisit if Option B is ever chosen** (it removes a client-visible PATCH field).

---

## 4. Phased delivery plan (epic + stories)

Epic: **Auto node-role adjustment (head/worker/standalone) from serving-setup membership (IRI-050)** — order respects the dependency chain; S1 unblocks S2; S3 and S4 are independent of each other.

| # | Story | Scope | Acceptance criteria |
|---|---|---|---|
| S1 | Derivation contract in packages/core | `deriveNodeRoles` + diff helper, unit tests | Pure function; head>worker precedence; dangling worker ids ignored; returns only changes when diffed against current roles |
| S2 | Wire derivation into setup create/patch/remove | `setups-service.ts` hook (ordering per G7), `refreshNodeConfig` per changed node | Creating a cluster sets head→head, workers→worker; worker config-update carries `llmCadenceMs: 10_000, llmDetectOnly: true` live (extend `apps/server/test/llm.test.ts:185-204, 505-557` pin pattern); patch flips roles both ways (added worker → worker; removed → back); removing a stopped setup returns members to standalone **unless** another setup still claims them (multi-membership precedence); manual role PATCH still works (G6 preserved by design) |
| S3 | Membership hygiene on node delete | Node delete strips the id from all `setups.nodes` jsonb (G5); derivation filters unknown ids | Deleting a worker node leaves no dangling ids; surviving setups still parse through `setupNodeSchema`; no role writes attempted for deleted rows |
| S4 | Web copy + docs | NodeModal role helper text ("auto-adjusted when serving setups change"); `docs/API.md` role-field note (derivation + precedence, override semantics) | `.agentic/bin/docs-check` green; helper text visible in add/edit modal |

Verification per `/implement`: `pnpm test` (new server tests for the three ops + live config-update pin), `pnpm build`, `.agentic/bin/validate`; live smoke on DEV: create a 2-node setup → worker card shows `worker` chip + 10 s detect-only panel; delete setup → both return to `standalone`.

Implemented 2026-10-30 as IR-136..IR-139 (sprint 990, branch `feat/IRI-050-node-role-auto-derivation`); the API-facing derivation note lives in `docs/API.md` (Nodes section).

---

## 5. Risks & open questions

- **Role flapping during wizard churn (G4):** each event recomputes from the full setup set, so churn converges; worst case is one config-update per member per event. Bounded, no mid-churn inconsistent state (diff is atomic per node).
- **Live cadence flips while a setup runs** (patch is editable while running, §1.4): intended — an orchestrated worker probing its own rate windows at 2 s was the misbehavior; detection-only is correct.
- **No backfill:** existing rows (manually set, mostly consistent: DGX-1 head, DGX-2/3 workers, NAS standalone) are NOT rewritten at deploy; derivation applies from the next membership event. Avoids surprising overwrites of intentional manual states. [INFERENCE on current fleet state — verify in DEV smoke.]
- **Pre-existing dangling worker ids** (G5, from past node deletes): S3 cleans them; before S3, derivation tolerates them (rule 2).
- **NAS-as-head** remains possible (pre-existing wizard behavior, `ServeView.vue:753-756`); out of scope, flagged only because derivation will label such a NAS `head`.
- **Open (owner):** Option B (fully derived, no manual override) as a follow-up; one-time reconciliation script for existing rows if fleet drift is found.

---

## 6. Jira overlap findings (project IR, searched 2026-10-30)

- No open issue mentions node roles, multi-node, cluster, or worker roles (`project = IR AND text ~ "role"/"cluster"/"multi-node"/"worker"`, `statusCategory != Done` → 0 hits; only open epic is IR-51, usage phase 2 — unrelated).
- Related **done** work to link, not duplicate: IR-56 (node management UI epic — introduced the manual role select), IR-23 (head card + cluster view — role-based surfaces), IR-105 (node page UX), IR-101 (cacheUser — same AGENT_CONFIG_KEYS live-push pattern reused here).
- Task history: IRI-041 (setup edit NAS-worker deadlock) touched the same validation block — read before editing `validateWorkers`.

## Summary of Findings

1. Role exists end-to-end with exactly one functional consumer (worker → 10 s detect-only probes) and live propagation via `config-update`; everything else is display sugar that already reacts to role.
2. Setup membership lives in `setups.headNodeId` + workers jsonb and is edited via `create/patch/remove` (+ wizard delete-recreate); **none of these touch `nodes.role`** — that is the entire gap.
3. Fix = pure derivation over all setups (head > worker > standalone), applied server-side at the three membership ops with write-only-diffs + `refreshNodeConfig` per changed node, ordered before `ensurePortAssigned`. No schema, no agent change, no new UI vocabulary.
4. Manual override stays (Option A); full derivation (Option B) rejected for now — it would break head-marking of non-setup engines.
5. Adjacent hygiene worth one story: node delete leaves dangling worker ids in setups jsonb (G5).
6. No Jira overlap; new epic + 3–4 small stories justified.
