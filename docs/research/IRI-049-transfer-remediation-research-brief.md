# IRI-049/050 — Transfer remediation: interrupted sync-local orphans + silent push 409

Research brief · 2026-10-30 · investigated from live DEV hub (10.20.30.9:3947) + source. Evidence: live jobs API probes, three scout traces (server/web, agent/modelctl 0.23.0, push dispatch). Skill: `research` (planning only — no code in this step).

## Summary

Two defects in the model transfer lifecycle, hit back-to-back on 2026-10-30:

1. **Interrupted sync-local → orphan that the Register CTA cannot adopt.** A canceled/failed NAS→node `sync-local` leaves a partial `models--*` cache dir. The agent reports it as an orphan; the UI offers exactly one action, **Register** — but `modelctl register-local` structurally refuses any interruption at or before "snapshot renamed", which is every mid-transfer stop. The only remediation is re-running `sync-local` (cheap: deterministic staging dir + `rsync --partial` resume), and no UI affordance exists for that. Owner hit this live: register-local job `d9a932b8` failed with `has no snapshot for store commit '2d747d0e…'` on the `Mia-AiLab/GLM-5.3-EXL3-2.75bpw-TensorFold` orphan left by canceled job `51a3bf4c` (stopped at 9%, 28.9G).
2. **Push via another node silently 409s.** Push dispatches to the relay node; the relay rejects with 409 `node already has an active job` whenever it has ANY queued/running job. The 08:44:03 409 was DGX-1 holding running sync-local `4fcf1f15` (started 08:41, the owner's re-pull of `GLM-5.3-Flash-EXL3-4bpw-TensorFold`). The error surfaces only as an inline banner inside the open drawer; the Push button itself shows no busy state.

Proposal: **two tickets, no epic** (small, independent surfaces). IRI-049 = orphan states + Resume transfer (P1). IRI-050 = relay busy state + 409 surfacing (P2).

**Filed 2026-10-30: IR-133 (IRI-049, High) · IR-134 (IRI-050, Medium) — sprint 990 (IR Sprint 2), links: IR-133↔IR-104/IR-131, IR-134↔IR-121/IR-113.**

## Current state (evidence)

### Pipeline shape

- Transfers are node jobs: hub `POST /api/v1/nodes/:id/jobs` (`apps/server/src/app.ts:773-801`) → `jobs.create` (`apps/server/src/jobs-service.ts:262-293`) → agent frame → `buildCommand` (`apps/agent/src/modelctl.ts:212-218`). sync-local argv: `["sync-local", <name>, "--source-root", <nasRoot>]` + runuser wrap for the cache user (`modelctl.ts:298-307`, `apps/agent/src/cache-user.ts:16-35`).
- Success of `sync-local`/`download`/`push`/`register-local` upserts the `node_models` placement row (`jobs-service.ts:534-536`); any terminal state of these kinds drops the cached `node_inventory` so the next read re-reports (`jobs-service.ts:553-556`).

### Orphan detection and the Register CTA

- Orphans are an **agent-side readdir diff**: `registered` from `modelctl list --local --json` vs entries of `<cache>/models--ORG--REPO` (`apps/agent/src/inventory.ts:296-316`, decode `:266-278`). Reported as `orphans: string[]` on `InventoryLocalCache` (`packages/core/src/inventory.ts:59`, defaulted for old agents), persisted into `node_inventory` on models-inventory success (`jobs-service.ts:60-77`), served by `GET /api/v1/nodes/:id/models` (`app.ts:686-697`).
- The diff is **name-based only** — it cannot tell a partial transfer from an adoptable cache entry. A partial sync surfaces as an orphan because modelctl ensures `models--ORG--REPO/` dirs *before* rsync (`modelctl/src/modelctl/hf_cache.py:527-535`).
- Register button → `askRegister` → confirm card (`apps/web/src/components/NodeDetail.vue:813-826`, `:436-447`; copy in `apps/web/src/inventory.ts:121-129` — "verified against the NAS by hash, nothing transferred") → `POST {kind:"register-local", params:{name, user}}` (`apps/web/src/inventory.ts:111-119`, `apps/web/src/models.ts:65-78`) → agent runs `modelctl register-local <name> --source-root <nasRoot>` as the cache user (`modelctl.ts:464-486`).

### modelctl 0.23.0 semantics (the crux)

- `register_local_cache` structural refusals (`hf_cache.py:940-954`): cache entry present (`:941-945`), usable blobs dir (`:946-949`), and **`snapshots/<40-hex store commit>` exists** (`:950-954`). Content verification is fail-closed (LFS by blob name+size, small files by git-blob hash, `:851-907`); verification never creates refs (`:769-787`); for commit-hash revisions the ref check is skipped entirely (`:769-771`).
- `sync_local` stages into a **deterministic** dir `<cache>/models--ORG--REPO/.modelctl-staging/<commit>-<selection16>` and rsyncs `--archive --partial --delete` from the NAS store object (`hf_cache.py:153-154, 519-535, 544-554`). Re-running sync-local resumes into the same staging dir; identical files are skipped (quick-check), `--partial` keeps interrupted files. Modelctl's own failure text says "staging is resumable" (`:562`).
- Registration finalize order: rsync → verify staged files (full etag read) → move blobs → rename snapshot farm into `snapshots/<commit>` → publish ref (non-commit revisions only) → write registration record (`hf_cache.py:630-749, 588-627`).

**Interruption → Register outcome** (verified against source, `hf_cache.py`):

| Interruption point | On-disk state | `register-local` | Recovery |
|---|---|---|---|
| (a) mid-blob-copy (cancel/SIGTERM) | staging partial, no snapshot/ref/record | **FAIL** `:950-954` | re-run sync-local (cheap resume) |
| (b) blobs copied, snapshot not renamed | blobs complete, no `snapshots/<commit>` | **FAIL** `:950-954` | re-run sync-local (near-free) |
| (c) snapshot renamed, ref unpublished | `snapshots/<commit>` complete | commit-hash revision: **SUCCESS** (`:769-771`); tag revision: **FAIL** (missing ref, `:774-783`) | register works / one more sync |
| (d) ref published, record unwritten | snapshot + ref present | **SUCCESS** (idempotent record write, `:1024-1026`) | register |

- Cancel path: hub sets `cancelRequestedAt` (`jobs-service.ts:364-390`), agent SIGTERMs the process group, SIGKILL after 5s (`apps/agent/src/modelctl.ts:592-601`). **modelctl has no SIGTERM handler** (only KeyboardInterrupt → `PARTIAL_RESUMABLE` journal + cleanup, `cli.py:1613-1616`, `hf_cache.py:558-562`) — SIGTERM kills instantly; staging survives (resumable by determinism), the `.files` list leaks, the journal stays `RSYNC_TO_CACHE_STAGING`.

### Live incident timeline (DEV hub jobs API, 2026-10-30, all DGX-1 unless noted)

| Time | Job | Outcome |
|---|---|---|
| 10-29 18:47 | sync-local `GLM-5.3-Flash-EXL3-4bpw-TensorFold` | failed exit 1 — "rsync failed; staging is resumable" |
| 10-29 21:09 | sync-local `GLM-5.3-EXL3-2.75bpw-TensorFold` | failed mid-rsync (57.10G, 19%), no diagnostic captured |
| 10-29 21:22 | sync-local `GLM-5.3-Flash-EXL3-4bpw-TensorFold` | canceled ("...killed.") |
| 10-29 21:30 / 22:00 | register-local (same TensorFold) | failed: "has no snapshot…" / "cache entry … not present; use 'modelctl sync-local'" |
| 10-30 07:17 | sync-local ×3 (DGX-1/2/3) `GLM-5.3-Flash-EXL3-4bpw` | canceled (user stopped the batch) |
| 10-30 07:29→07:34 | sync-local `GLM-5.3-EXL3-2.75bpw-TensorFold` | **canceled at 9% (28.9G)** — leaves today's orphan |
| 10-30 07:37 | download-queue (NAS) | succeeded — TensorFold published to `/mnt/llms/models/Mia-AiLab/…` |
| 10-30 07:36-07:38 | sync-local `GLM-5.3-Flash-EXL3-4bpw` DGX-1/DGX-2 | succeeded (registered; matches catalog) |
| 10-30 08:37 | **register-local `Mia-AiLab/GLM-5.3-EXL3-2.75bpw-TensorFold`** | **failed** — "has no snapshot for store commit '2d747d0e30eca6e3fe37ba63c471cdf9172faa83'" |
| 10-30 08:41→ | sync-local `GLM-5.3-Flash-EXL3-4bpw-TensorFold` | running (the owner re-pulling; 31% at probe time) |
| 10-30 08:44:03 | **POST push → DGX-1** | **409** — relay busy with the job above |

### Push dispatch path

- Payload: `{kind:"push", params:{name, hosts:["<cacheUser>@<host>"], jobs:4}}` POSTed to the **relay** node id — `viaNodeIds[0]` from the pure planner (`apps/web/src/components/ModelsView.vue:959, 674-680`; `packages/core/src/catalog.ts:101-137`, holders ordered online-first, NAS excluded `:112`). The relay executes `modelctl push <name> --host <user@dest> --jobs 4` behind an ADR-0014 preflight (`apps/agent/src/modelctl.ts:315-343, 87-140`; `docs/adr/0014-self-provisioned-push-dependencies.md`).
- The route's only 409s (`app.ts:796-797` ← `jobs.create`): ① any `jobs` row for the node with `status IN ('queued','running')` → `` `node already has an active job (${active.id})` `` (`jobs-service.ts:298-313`); ② concurrent-insert loss on partial unique index `jobs_node_active_uq` (`packages/db/src/schema.ts:194-199`, `jobs-service.ts:313`); ③ agent WS not connected (`jobs-service.ts:328-337`). Bench runs use a separate slot (`bench_runs_node_running_uq`, `schema.ts:416-417`); download-queue batches occupy the same slot on their store node (`download-queue-service.ts:191-213`).
- **Cancel does not free the slot** until the agent's cancel-ack settles the row (`jobs-service.ts:411-419`).
- Surfacing: `createJob` throws with the server message (`apps/web/src/models.ts:64-77`), caught into an inline `banner--warn` **inside the open drawer** (`ModelsView.vue:682-690, 1011`; NodeDetail parity `:855`). The Push button's visibility checks only destination online (`ModelsView.vue:957`) — never relay busy.
- No presence validation at dispatch; the button's existence implies placement as of drawer load (stale by click time). ADR-0014's busy-retry (`BUSY_RETRIES`, `apps/server/src/push-remediation.ts:24-27, 118-131`) covers only the reactive IRORI_PUSH_BLOCKED path, not user-initiated pushes.

## Gap analysis

- **G1 — no orphan classification.** The readdir diff yields bare repo strings; adoptable (interruption ≥ (c)) and partial (≤ (b)) states render identically, and Register is the only CTA. For partials it *always* fails — confirmed live at 21:30, 22:00, 08:37.
- **G2 — no Resume affordance.** The designed recovery for (a)/(b) is re-running sync-local, which is dispatchable via API but has no UI (download-queue rows have Retry; plain node jobs and orphans don't).
- **G3 — misleading static copy.** "verified against the NAS by hash, nothing transferred" describes a register that *can* succeed; on a partial it's dead ends with a failed job in the Activity feed only.
- **G4 — modelctl upstream (deferred).** SIGTERM doesn't journal `PARTIAL_RESUMABLE` and leaks the `.files` list. Resume works regardless; fixing it is a pinned-dependency bump for cosmetic state. Defer.
- **G5 — relay busy is invisible.** Push (and Register / inventory Refresh, `app.ts:699-717`) 409 while the node has any active job; the only signal is a banner inside an already-open drawer. Owner read the 409 as "push not working".
- **G6 — observed anomaly (no action).** Failed sync-local `ce4afb22` stopped at 19% with no diagnostic in its output; resume semantics cover it.

## Proposed design

### IRI-049 (P1) — Orphan states + Resume transfer

Decision: classify orphans at inventory time and give each state its own CTA; keep register-local as the adoption path (fail-closed) and re-dispatched sync-local as the recovery path.

- **Agent** (`apps/agent/src/inventory.ts`): for each unregistered `models--*` dir, classify: `adoptable` when `snapshots/<40-hex>/` exists (structural register preconditions plausibly met; modelctl still verifies content fail-closed); `resumable` when only `.modelctl-staging/<commit>-*` exists (partial transfer); else `unknown` (fall back to Register-only). No NAS round-trip needed.
- **Core schema** (`packages/core/src/inventory.ts`): keep `orphans: string[]`; add additive optional `orphanStates?: { repo: string; state: "adoptable"|"resumable"|"unknown" }[]` (default `[]`) so pre-0.23-agent rows and cached reports keep parsing.
- **Web** (`NodeDetail.vue` orphan rows): per-state CTA — adoptable → existing Register; resumable → **Resume transfer** dispatching `{kind:"sync-local", params:{name: <same derivation as RegisterRequest>, user: <cache user>}}`; unknown → Register (current behavior). Per-state hint copy: resumable = "partial transfer — Resume continues from staging; completed files are not re-copied".
- **Server**: no changes (dispatch path exists; INVENTORY_MUTATING_KINDS already drops the cached report so a post-resume refresh re-reports registered).

Rejected alternatives: auto-register on terminal states (fails closed for partials → noise); auto-resume on cancel (fights explicit user intent); live hash-verify before showing Register (register-local *is* the verifier).

### IRI-050 (P2) — Relay busy state + 409 surfacing

Decision: keep the one-active-slot constraint (ADR-0014; concurrent sync+push would contend for relay disk/net) and make the constraint visible instead of bypassing it.

- **Web** (`ModelsView.vue` placement drawer): derive relay-busy from the already-streaming live job state; render Push rows disabled/labeled with the blocking job ("via DGX-1 busy — sync-local GLM-5.3-Flash-EXL3-4bpw-TensorFold, 31%"). Same treatment for NodeDetail Register/Refresh actions.
- **Server** (small): include the blocking job's `kind`/`params.name` in the 409 message (currently only the id: `jobs-service.ts:303`) so the banner is self-explanatory without a client-side lookup.

Rejected alternatives: bypass the slot for pushes (resource contention on relay); proactive busy-retry of user-initiated pushes (surprises the user with a delayed dispatch; ADR-0014 retry is for the reactive remediation path only).

## Phased delivery plan

| # | Ticket | Priority | Depends on |
|---|---|---|---|
| 1 | IRI-049 orphan states + Resume transfer | High | none |
| 2 | IRI-050 relay busy state + 409 surfacing | Medium | none (independent; ships either order) |

**IRI-049 acceptance criteria**
1. Cancel a sync-local mid-transfer → Refresh → the orphan row shows the resumable state with a Resume CTA (not Register).
2. Resume dispatches sync-local for that node/user; on success the entry is registered, the orphan row disappears, and completed blobs are not re-copied (rate ramp / short duration on retry is observable).
3. An adoptable orphan still shows Register and register-local succeeds (zero-transfer path preserved).
4. Inventory reports from pre-change agents (orphans as plain strings) still render.

**IRI-050 acceptance criteria**
1. With a queued/running job on the relay, the Push row shows the busy state naming the blocking job.
2. A stale click still 409s; the drawer banner names kind + model of the blocking job.
3. NodeDetail Register / inventory Refresh show the same busy treatment.

## Risks & open questions

- Adoptable heuristic is structural only; a `snapshots/<commit>` from a *failed earlier* publish is conceivable — register stays fail-closed, so worst case is a failed job with modelctl's mismatch text. Acceptable.
- Resume name resolution reuses the Register derivation (proven: the failed register resolved the store commit, so `resolve_active_name` accepted the repo-style orphan string).
- Stale cached reports: node_inventory persists until the next models-inventory; Resume on a stale "resumable" is safe — sync-local into completed state re-registers idempotently (`hf_cache.py:927-929`).
- Owner call: for busy relays, disable vs hide the Push row; and whether the busy label lives in the drawer row or the confirm card.
- Sprint placement: sprint 990 ends 2026-10-31 — file into the next sprint or backlog?

## Jira overlap findings

- **IR-104** (Done) — register-local job, orphan detection, UI. IRI-049 extends it; link Relates.
- **IR-131** (Done) — transfer tracking + stop, cancel survives modal close. The cancel machinery IRI-049 builds on.
- **IR-112/113/114/115/121** (Done) — push self-healing family, drawer, telemetry labels. IRI-050 extends IR-121's drawer; ADR-0014's one-active constraint is respected, not changed.
- **IR-100** (Done) — placement from CX7 holder (`viaNodeIds` planner) — context for "via" semantics; no change.
- No open ticket overlaps. Numbers **IRI-049 / IRI-050 are free** (checked `tasks/`, `docs/research/`, local+remote branches, Jira text search 2026-10-30).
