# IRI-041 research brief — Setup edit deadlock: legacy NAS/duplicate worker rows make Save impossible

- **Date:** 2026-10-28
- **Ticket:** IRI-041 (Jira ticket not yet created — no open IR tracks this)
- **Goal:** Why does saving the edit of the fleet's cluster setup fail with `NAS is a NAS node and cannot be a worker`, and what is the correct repair?

## 1. Symptom (owner screenshots, 2026-10-28, live DEV hub 10.20.30.9:3947)

Edit setup wizard on the serving page:

- **Review (step 5):** `type: cluster — head + 6 worker(s)`, red banner `NAS is a NAS node and cannot be a worker`. Name `GLM-5.3-FLASH-ABILT`, model `GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit`, port `8081`, scripts `…/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold/start-tp3.sh` + `stop.sh`. The user is retargeting the existing cluster setup at a new model variant; the wizard title "Edit setup" means `editId !== null` (`ServeView.vue:723`).
- **Placement (step 4):** `DGX-1 · head / present`, `DGX-2 · worker / present`, `DGX-3 · worker / push · 163.6 GB`, `NAS · standalone / present`.

The fleet has exactly 3 spark nodes + 1 NAS (§3): a legitimate cluster here is head + ≤ 2 workers. `head + 6 worker(s)` is itself the anomaly — it is a count of stored worker *rows*, not nodes (`ServeView.vue:832`: `` `cluster — head + ${wizard.workerIds.length} worker(s)` ``).

## 2. Server side: where the error is thrown

`apps/server/src/setups-service.ts:307-324`:

```ts
/**
 * Worker rows must reference real spark nodes — not the head itself, not a
 * NAS node, no duplicates. Nothing validated this once and a row shipped
 * with DGX-3 x4 plus the NAS listed twice as a worker.
 */
const validateWorkers = async (
  workers: Array<{ nodeId: string; role: "worker" }>,
  headNodeId: string,
): Promise<void> => {
  const known = new Map((await deps.getNodes()).map((n) => [n.id, n]));
  const seen = new Set<string>();
  for (const worker of workers) {
    if (seen.has(worker.nodeId)) throw new SetupInvalidError(`duplicate worker node ${worker.nodeId}`);
    seen.add(worker.nodeId);
    if (worker.nodeId === headNodeId) throw new SetupInvalidError("the head cannot be its own worker");
    const row = known.get(worker.nodeId);
    if (row === undefined) throw new SetupInvalidError(`unknown worker node ${worker.nodeId}`);
    if (row.kind === "nas") throw new SetupInvalidError(`${row.name} is a NAS node and cannot be a worker`);
  }
};
```

- Check order per row: duplicate → head-self → unknown → NAS-kind. The docstring documents the exact incident class.
- Wired at create (`setups-service.ts:380`) and at patch — but only `if (patch.nodes !== undefined)` (`setups-service.ts:406`).
- HTTP mapping: `apps/server/src/app.ts:1004-1005` (PATCH) and `:1030-1031` (POST create) return `400 { error: err.message }` for `SetupInvalidError`; the wizard renders it in the banner (`ServeView.vue:850`).

## 3. The stored row (ground truth, live API 2026-10-28)

`GET /api/v1/setups` (trimmed to relevant fields) — exactly one setup row exists:

```json
{
  "id": "69916930-c6d5-4d4a-98e7-2d05ed7c74d8",
  "name": "glm-5.3-flash-exl3-q4",
  "kind": "cluster",
  "model": "glm-5.3-flash-exl3-q4",
  "port": 8080,
  "headNodeId": "7a575210-a47f-4877-9eb9-f384953a7baa",
  "nodes": [
    { "nodeId": "9674a9fc-7dfd-44c7-bf93-c6365f4ac470", "role": "worker" },
    { "nodeId": "359896b6-aaa9-475d-b5b8-f63085e8d1ea", "role": "worker" },
    { "nodeId": "63a12a25-296f-4b89-b1ce-982ed5992aaf", "role": "worker" },
    { "nodeId": "359896b6-aaa9-475d-b5b8-f63085e8d1ea", "role": "worker" },
    { "nodeId": "63a12a25-296f-4b89-b1ce-982ed5992aaf", "role": "worker" },
    { "nodeId": "359896b6-aaa9-475d-b5b8-f63085e8d1ea", "role": "worker" }
  ],
  "status": "stopped",
  "lastError": "MODEL_PATH resolution failed for glm-5.3-flash-exl3-q4 (modelctl path --local)",
  "createdAt": "2026-10-24T10:45:50.174Z",
  "updatedAt": "2026-10-25T08:32:00.086Z"
}
```

`GET /api/v1/nodes` (verbatim, 2026-10-28):

| id | name | kind | role | nasRoot |
|---|---|---|---|---|
| `7a575210-a47f-4877-9eb9-f384953a7baa` | DGX-1 | spark | head | /mnt/nas |
| `9674a9fc-7dfd-44c7-bf93-c6365f4ac470` | DGX-2 | spark | worker | /mnt/nas |
| `359896b6-aaa9-475d-b5b8-f63085e8d1ea` | DGX-3 | spark | worker | /mnt/nas |
| `63a12a25-296f-4b89-b1ce-982ed5992aaf` | NAS | nas | standalone | /mnt/llms |

So the stored `nodes` = **DGX-2 ×1, DGX-3 ×3, NAS ×2** (6 rows). The NAS row sits at index 2, before any duplicate — therefore the first (and only) validation error is the NAS-kind error, exactly the screenshot's banner. Had the order differed, it would have been `duplicate worker node …`.

## 4. Why the wizard cannot fix it (round-trip deadlock)

All in `apps/web/src/components/ServeView.vue`:

- **Edit load is verbatim** — `:294` `w.editId = from?.id ?? null`, `:298` `w.workerIds = from ? from.nodes.map((n) => n.nodeId) : []`. No sanitize: NAS ids and duplicates enter wizard state.
- **TYPE step hides the poison** — `:744` the worker checkbox list is `nodes.filter((x) => x.id !== wizard.headNodeId && x.kind !== 'nas')`: NAS ids are invisible **and unremovable**. Duplicate ids render as a single checked box (`:745` uses `includes()`), so the UI shows 2 checked boxes while review counts 6. The push cap is `wizard.workerIds.length < 7` (`:745`).
- **Save round-trips the poison** — `:572-573` edit path is a plain `patchSetup(editId, wizardInput())`; `:458` builds `nodes: w.workerIds.map((nodeId) => ({ nodeId, role: "worker" }))` verbatim → server 400 → banner. No destructive delete precedes the failed PATCH (the edit flow never DELETEs; the IRI-022 delete+re-POST is the failed-*start* retry path for new setups only).
- **Every other wizard action is equally blocked:** `onStageTransfers` → `ensureCreated()` which PATCHes first (`:474-480`); `onSaveOnly` → `ensureFreshCreated()` (IRI-022 path); `onDuplicate` (`:213-217`) copies `workerIds` into a *create* → `setups-service.ts:380` throws on POST.
- **Placement NAS row is an artifact of the corruption** — `:513-523`: `wanted = new Set(targetIds())` where `targetIds()` = `[head, ...workerIds]` (`:445-447`); NAS appears on the placement step only because the corrupt workerIds contain it. A clean cluster would not show NAS there.

Net effect: the row is uneditable and unduplicatable through the UI; the only escapes are delete + recreate (losing env/capture config) or direct DB surgery.

## 5. Origin and chronology

Schema: `packages/db/src/schema.ts:315-316` — `nodes: jsonb("nodes").notNull().default(sql`'[]'::jsonb`)`, free-form; no DB constraint prevents NAS/duplicate rows.

| When (UTC) | Event |
|---|---|
| 2026-10-24 10:45:50 | Setup row created — `nodes` written corrupt (DGX-2 ×1, DGX-3 ×3, NAS ×2). Validation did not exist yet. |
| 2026-10-25 07:56:09 | Commit `4c9f1a2` ("Overview v2, telemetry UX and setup-flow fixes", IR-78 epic): adds "wizard worker-checkbox fix + server-side setup-nodes validation" — the NAS checkbox filter and `validateWorkers`. No repair of pre-existing rows. |
| 2026-10-25 08:32:00 | Row `updatedAt`. Whether a nodes-carrying PATCH succeeded here (i.e. before the `4c9f1a2` deploy reached the VM) is **not established** — deploy timestamp not checked. Non-load-bearing for the fix. |
| 2026-10-28 | Owner edits the row (rename, Ablit model, port 8081) → PATCH 400 → deadlock. |

Corrupt rows created before 2026-10-25 were never re-validated; validation only guards *new* writes.

## 6. Fix options

| Option | Mechanism | Tradeoff |
|---|---|---|
| **A. Sanitize in the wizard (recommended)** | Pure helper `sanitizeWorkerIds(workerIds, headNodeId, nodes)` — dedupe (keep first occurrence), drop head-self, drop NAS-kind, drop unknown ids, preserve order. Call it in `openWizard` for edit/duplicate display **and** in `wizardInput()` so every POST/PATCH path (Save, Save-without-starting, Stage transfers) persists clean rows. Server stays strict. First Save also *repairs* the stored row. | Silently rewrites stored config — but only removes rows the server itself declares invalid; the row is otherwise unusable, and edit is the repair surface. Needs `nodes` inventory in scope at both call sites (the view already has it). |
| B. Expose raw worker rows in the TYPE step | Render each stored row as a removable chip (incl. NAS/dupes) so the user fixes it manually. | No silent rewrite, but clunky UI, and the user must understand "6 workers vs 2 checkboxes". Deadlock persists until manual fix. |
| C. Server-side lenient repair on PATCH | Sanitize `patch.nodes` instead of throwing. | Weakens the exact guard added to stop corrupt rows (`setups-service.ts:307-310`); corrupt rows could persist via non-wizard clients. |
| D. One-time DB migration | Normalize `setups.nodes` jsonb at migration time. | Heaviest; NAS-kind/unknown checks need the `nodes` table in scope at migration; future corrupt rows (impossible post-validation, but still) would still deadlock. |

**Staging is unaffected by A:** the NAS-first transfer chain picks the store node from the whole inventory — `setups-service.ts:704-706` `const nasNode = pickStoreNode(allNodes)` — never from the setup's worker rows. Dropping NAS from `nodes` changes nothing about `HF → NAS → cluster` staging (ADR-0009).

Verification shape (per the IRI-022 fixture-browser pattern): serve built dist with a `window.fetch` mock carrying the corrupt row; open edit → review must show `head + 2 worker(s)`; Save → exactly one PATCH with deduped spark-only `nodes`, banner absent; duplicate → one POST, accepted. Plus a unit test for the helper (drop NAS/dupe/head/unknown, keep first occurrence and order).

## 7. Not broken (do not touch)

- `validateWorkers` itself — correct and load-bearing (it caught this).
- The TYPE checkbox NAS filter and the `< 7` cap.
- Server strictness on create/patch.

## Summary of Findings

1. **Why the error:** the stored setup row (`69916930…`, created 2026-10-24, one day before validation shipped) carries 6 worker rows — DGX-2 ×1, DGX-3 ×3, NAS ×2. The wizard loads them verbatim (`ServeView.vue:298`) and PATCHes them verbatim (`:458`), and `validateWorkers` (`setups-service.ts:323`) rejects the NAS row with the exact banner text.
2. **Why the UI can't fix it:** the TYPE step filters NAS out of the checkbox list (`ServeView.vue:744`) so the bad rows are invisible and unremovable; duplicates collapse into one checkbox; Save, Stage transfers, Save-without-starting and Duplicate all funnel the same corrupt list into a validated POST/PATCH.
3. **Origin:** the row predates `4c9f1a2` (2026-10-25, IR-78 epic) which added both the checkbox filter and server validation but no repair of existing rows; `setups.nodes` is unconstrained jsonb.
4. **Correct fix:** Option A — a pure sanitize helper applied at wizard load (display) and payload build (persistence), leaving the server strict; the next successful Save self-heals the row. Staging/ADR-0009 behavior is independent of worker rows (`setups-service.ts:704-706`).
5. **Open:** create the Jira ticket (next IR key after IR-118) + sprint, then the task file; the 2026-10-25 08:32 `updatedAt` question (whether a nodes-carrying PATCH succeeded pre-deploy) is measurable only from VM deploy timestamps and is not load-bearing.
