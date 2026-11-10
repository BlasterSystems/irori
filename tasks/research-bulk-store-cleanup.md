# Research: Bulk NAS store cleanup (batch model deletion)

Status: RESEARCH — no code, no tickets created yet. Human validation gate at the bottom.

## Jira target

- Project key: **IR** (Irori) · site: **blastersystems.atlassian.net** (confirmed live via REST search response in this session)
- Board: **5** · active sprint: **1004 "IR Sprint 4"** (2026-11-08 → 2026-11-15; re-verify at creation)
- Issuetype ids: Task **10024** (per irori-merge-deploy-closeout skill, verified 2026-10-29); Epic id to re-read via createmeta at creation
- Transitions: To Do = 11, In Progress = 21, Done = 31
- How resolved: repo config (`AGENTS.md` IRI-<n> task convention; skill `irori-jira-ticket-filing` = "Irori Jira project IR tickets"), site host confirmed by this session's `jira_search` response; board/sprint/issuetype ids from the 2026-11-09 verified session (IR-206/IR-201 runs). Re-verify all ids at creation time — never carried blindly.

## Summary

The owner needs ~4.6 TiB freed on the NAS store (Pool 2 at 82%). A 77-name delete list resolves to **75 concrete models (4.59 TiB)**. Today that means 75 sequential hub jobs or direct SSH (now blocked — password rotated). This doc plans (a) the immediate operational batch using existing hub job kinds, and (b) a proper bulk-delete feature so this is one job next time.

## Current state (evidence)

- Store: `/mnt/llms` in the NAS LXD container is a direct ext4 bind of the QNAP share; **modelctl-owned** (ADR-0004; `docs/ARCHITECTURE.md:33`, `docs/SPEC.md:237`).
- Delete path that exists today: hub job kind `nas-delete-apply` → agent runs `modelctl delete NAME --json` (plan), preflights every object/staging dir with a create+unlink probe, then `--apply --yes` (`docs/API.md:238-241`); agent wrapper `apps/agent/src/modelctl.ts` (destructive-kinds convention: armed variant passes `--apply --yes` explicitly).
- **One active job per node**: `create()` throws `JobBusyError` on any queued/running job (`apps/server/src/jobs-service.ts:338-341`, exercised in `apps/server/test/job-events.test.ts:44`). 75 deletes = 75 serialized jobs on the NAS node.
- Cache reconcile is live as of **dev-0.6.0-7** (PR #105, merged `a83380c`): `onCatalog` prunes `model_meta` rows absent from a complete `source=catalog` frame (`apps/server/src/jobs-service.ts:640-648`), and failed catalog-mutating settles also request a re-read (`jobs-service.ts:611-618`). Verified in production 2026-11-10: cache went 25 → 150 rows after a refresh; stale gemma row gone.
- Agents: DGX-1/2/3 run **0.6.0** and answer `catalog-request` with the complete store (`apps/agent/src/catalog-read.ts:142-143`); the NAS agent is **0.5.1** and still executes hub jobs (`modelctl` as root).
- Store inventory (hub DB `model_meta`, mirrored from catalog frames): **150 models, 9.44 TiB total**.
- `.staging` holds ~932 GB of stale partial downloads incl. `.active-quarantine` / `.cleanup-quarantine` (2026-11-09 incident summary) — sibling hygiene concern, covered as a story below.

## The requested batch (resolved 2026-11-10 against `model_meta`)

- 77 requested names → **74 exact matches**, **1 prefix match** (`Qwen3.8-Flash-Next-NVFP4-RadixA` → `Qwen3.8-Flash-Next-NVFP4-RadixArk`), 0 ambiguous.
- Unresolved: `gemma-4-31b-it-ud-q8-k-xl` (already deleted 2026-11-09, 35 GiB freed) and `lfm2.5-vl-3ba` (typo — store has `lfm2.5-vl-3b`; needs owner yes/no).
- **Batch = 75 models, 5,050,698,440,704 bytes ≈ 4.59 TiB**, leaving 75 models (~4.85 TiB) including the serving set (`GLM-5.3-Flash-EXL3-4bpw-TensorFold*`, `GLM-5.3-Flash-Uncensored-EXL3-4bpw`, TP/TP3 variants are NOT on the list).
- Full resolved list is embedded in the epic comment / appendix: `/tmp/delete-batch.json` on this workstation + `model_meta` in the hub DB.

## Gap analysis

| Need | Today | Gap |
|---|---|---|
| Delete one model | `nas-delete-apply` job (plan → preflight → apply) | none |
| Delete 75 models | 75 serialized jobs (one-active-slot) or SSH loop | no bulk kind; SSH now blocked (password rotated) |
| Cache consistency after out-of-band change | solved (a83380c) | none |
| Repeatable cleanup of `.staging` partials/quarantine | `cleanup-staging` job kind exists; no audit-driven prune of the 932 GB pile | operator has no safe one-shot |

## Proposed design

**Decision:** two-track.

**Track 1 — immediate batch, zero code (ops):** dispatch 75 existing `nas-delete-apply` jobs via `POST /api/v1/nodes/<NAS-id>/jobs` in a loop, waiting for each to settle (the one-active-slot constraint serializes them). Each job is the full audited path (plan → preflight → apply), output streamed to the job modal, and — post-#105 — every settle (succeeded *or* failed) triggers a catalog re-read, so the Models cache self-heals during the run. Estimated 10–40 min total. No SSH needed (password rotation irrelevant); ADR-0004 intact (everything via modelctl).

**Track 2 — product fix (epic):** bulk delete as a first-class flow.

- **S1 (agent): new `nas-delete-batch` job kind** — params `{names: string[]}`; per model runs the same modelctl plan→preflight→apply sequence used by `nas-delete-apply`, emitting one job-output line per model (`{"model":…,"status":"deleted"|"failed"|"skipped","error":…}`) plus a final JSON summary line (counts + per-model status). Reuses the existing per-model wrapper; no new modelctl flags. Tests mirror `apps/agent/test/m4.test.ts` job-kind pins + a fake-modelctl loop test.
- **S2 (hub): allowlist + settle handling** — `jobKindSchema`/dispatch allowlist gains the kind; add to `CATALOG_MUTATING_KINDS` and `INVENTORY_MUTATING_KINDS` (store contents change; the batch never touches local caches but the inventory drop is harmless and keeps one code path). Batch progress already streams via the job-output ring. Tests in `job-events.test.ts` (settle effects) + route test.
- **S3 (web): bulk action on the Models page** — multi-select rows → confirm modal listing names + total bytes (from the catalog) → dispatch one batch job to the store node; job drawer shows per-model progress. Reuse the existing delete confirm copy (ADR-0004 wording) and the setup-advisory check (`deleteSetupWarn`) extended to the batch (warn if any selected model is referenced by a setup).
- **S4: `.staging`/quarantine audit + prune** — a `cleanup-staging`-based flow that lists stale staging trees (age threshold), shows reclaimable bytes, and prunes on explicit arm. Covers the 932 GB pile including the quarantine dirs left by the 2026-11-09 repair.
- **S5 (docs): API.md job kind + SPEC.md models row update.**

Ordering: S1 → S2 → S3 (DB/protocol deps); S4 independent; S5 last. No DB migration anywhere (no schema change).

**Rejected alternatives:**
- *Hub-side fan-out of 75 single jobs as the product* — no new surface, but permanent N-job spam, per-job preflight overhead, and poor progress UX; fine as the one-time Track-1 op, wrong as the feature.
- *SSH `modelctl` loop* — blocked by the rotated password and unaudited; violates the "everything through the hub" operations model.
- *Hub reading/writing the store directly* — violates ADR-0004 (server container has no store mount; rejected in IRI-028).

## Rollout / rollback

- Track 1 needs no deploy (existing kinds, existing hub build).
- Track 2 ships behind nothing: the new kind simply 400s/“unknown job kind” on agents older than the release (`docs/API.md:227` precedent) — dispatch UI gated on the node's `agentVersion`.
- Rollback = revert PR; no migrations to unwind.

## Test strategy

- Agent: kind pin test + loop test with a stubbed modelctl binary covering plan-failure, preflight-denial, partial batch (one model fails → others proceed), and the final summary line.
- Hub: settle effects for the batch kind (no node_models writes — it's store-side; catalog-request fired; inventory row dropped), route allowlist test.
- Web: bulk-select dispatch + confirm-modal totals test.
- Ops batch (Track 1): verify per-job exit 0, store `modelctl doctor` clean, `catalog.json` count 150 − 75 + kept = 75, hub Models page correct, pool free space up ~4.6 TiB.

## Risks & open questions

1. **`lfm2.5-vl-3ba`** — typo for `lfm2.5-vl-3b`? Needs owner confirmation before the batch.
2. **Setups referencing deleted models** — single-delete flow warns via the setup-advisory; Track 1 must check placements first (`presentNodesFor` + setups) for all 75 names. Expected clean (serving set is not on the list), but must be verified, not assumed.
3. **NAS agent 0.5.1** executes `nas-delete-apply` fine (it's the wrapper the hub already uses), so Track 1 needs no agent update. S1+ does require an agent release on the NAS (`agent-update` restarts the agent — no setups run on the NAS, safe window needed anyway).
4. **IR-204 overlap** — the node-disk CTA row ("clean-up-disk") should deep-link this bulk flow once it exists; link both tickets rather than duplicate.
5. **Free-space floor** (incident open item 1: fail downloads when free < 1.5 TB) — related but separate; propose as its own story under IR-200 or this epic — owner's call.
6. The catalog/agent count discrepancy seen today (agents reported 150; pre-batch `modelctl` local count said 151) — recheck `modelctl doctor` before Track 1; the batch plan output per model makes any mismatch visible anyway.

## Jira overlap findings

- `IR-200` (Epic, open): disk-pressure visibility + operator CTAs — adjacent (motivation), not a duplicate; link.
- `IR-204` (Task, open): node-disk banner rows with clean-up-disk CTA — the CTA should eventually point at S3; link.
- No existing bulk/batch delete ticket (JQL text search 2026-11-10, project = IR, unresolved).

## HUMAN VALIDATION GATE — not passed

Do NOT create tickets or run the batch before the owner answers:
1. Create epic "Bulk NAS store cleanup" + 5 stories in IR (board 5, sprint 1004)? Y/N
2. Execute Track 1 now (75 `nas-delete-apply` jobs via the hub API)? Y/N — and is `lfm2.5-vl-3ba` → `lfm2.5-vl-3b`?
3. Free-space floor story: under this epic or IR-200?
