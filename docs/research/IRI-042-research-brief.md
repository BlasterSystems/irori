# IRI-042 research brief — MODEL_PATH resolution vs cache users; wizard model selection; hygiene clean CTA

- **Date:** 2026-10-28
- **Ticket:** IRI-042 (Jira IR-120)
- **Goal:** Decision-ready answers for three owner-reported failures before implementation:
  1. Setup start fails with `MODEL_PATH resolution failed for GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit (modelctl path --local)` although the model exists in the fleet (owner evidence: DGX-3 local cache).
  2. Owner suspects the wizard's model list "selects the model name and not the model_id".
  3. The disk-hygiene drawer shows no visible CTA to execute the clean.

---

## 1. Why MODEL_PATH resolution fails while the model exists

### 1.1 The start path (repo evidence)

- Server pre-check (`apps/server/src/setups-service.ts:447-455`): for a `MODEL_PATH` setup, start refuses with *"… is not staged on \<head\> — stage transfers first"* unless `presentNodesFor(row.model)` contains the head node. The owner's banner was **not** this error — the pre-check **passed**.
- `presentNodesFor` reads the `node_models` table (`apps/server/src/jobs-service.ts:507-510`), which is written on every successful `sync-local | download | push | register-local` settlement and pruned on deletes (`apps/server/src/jobs-service.ts:445-448`).
- Agent-side resolution (`apps/agent/src/setups.ts:256-263, 546-560`):

  ```ts
  /** `modelctl path --local NAME` → first stdout line. */
  private resolveModelPath(name: string): Promise<string | null> {
    …
    execFile(this.deps.modelctlPath, ["path", "--local", name], { timeout: 20_000 }, (err, stdout) => {
      if (err) {
        this.deps.log?.(`modelctl path --local ${name} failed: ${err.message}`);
  ```

  Failure returns `{ ok: false, error: "MODEL_PATH resolution failed for <name> (modelctl path --local)" }` (`setups.ts:260`) — the exact banner in the screenshot.
- The driver deps carry only `{ stateDir, modelctlPath, events, capture, log }` (`apps/agent/src/setups.ts:35-42`); `main.ts:205-207` constructs it with `config.modelctlPath` only. **No cache-user context.** `config.ts:77` defaults the binary to `/root/.local/bin/modelctl`.
- Contrast — every *transfer* kind is cache-user wrapped (`apps/agent/src/modelctl.ts:196-204`):

  > "When the node has a cache user, wrap modelctl in runuser with a scrubbed env (the IRI-028 delete-local pattern). … A missing user modelctl fails the build with an actionable error — it must never silently fall back to root's cache."

### 1.2 Live-fleet evidence (2026-10-28)

| check | result |
|---|---|
| Hub `GET /api/v1/nodes` | `cacheUser: "operator"` on DGX-1, DGX-2, DGX-3; NAS `null` |
| Hub `GET /api/v1/setups` | setup `GLM-5.3-Flash-Abilt` (id `e9d1e59a…`), model `GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit`, head DGX-1, cluster DGX-2 + DGX-3, `env.modelPath: true` |
| Hub `GET /api/v1/setups/e9d1e59a…` | one transfer `b52143d4…`: single stage **"DGX-1 → DGX-3 (push)"**, `hosts: ["operator@dgx3.lan"]`, **succeeded** 13:24:52→13:33:32Z |
| DGX-1 agent user | `ps -o user= -p $(pgrep -f irori-agent.mjs)` → `root` |
| DGX-1 journal | `modelctl path --local GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit failed: Command failed: /root/.local/bin/modelctl path --local GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit` (13:30:00 and 13:30:52) |
| DGX-1 as operator | `/home/operator/.local/bin/modelctl path --local GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit` → `/home/operator/.cache/huggingface/hub/models--Mia-AiLab--GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit/snapshots/57edefd2f5d9b371c8345883304d5af68b52fa24` |
| DGX-1 operator cache | contains `models--Mia-AiLab--GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit` |
| Hub `GET /api/v1/nodes/<dgx1>/models` | `report: null` — IRI-028 clears the inventory report when a model-mutating job settles; the pre-check passed via `node_models` rows, not the report |

Reading of the transfer: the push **source** was DGX-1 and it succeeded — the push kind runs cache-user wrapped (`apps/agent/src/modelctl.ts:357-391`: `runuser -u <cacheUser> -- env -u XDG_STATE_HOME -u HF_HOME -u HF_HUB_CACHE HOME=… PATH=… bash -c <script>`), so DGX-1 holds the model **in operator's cache**. The single push stage also implies DGX-1 and DGX-2 were skipped as already-holding (`setups-service.ts` pass 2 skips `holderIds.has(targetId)`).

`Command failed: /root/.local/bin/modelctl …` is the generic nonzero-exit message (an absent binary yields ENOENT instead), so root's modelctl **ran and failed**: root's per-user state has no such registration.

### 1.3 modelctl semantics (primary source `~/Developer/modelctl`)

- `modelctl path --local NAME` → `local_active_entrypoint(_cache_dir(...), name)` (`cli.py:1592-1594`) → `cached_entrypoint(cache_dir, name)` (`operations.py:901-903`, `hf_cache.py:1163-1165`) → `load_record` keyed by `_record_path(cache_dir, name)` = `state_root(cache_dir) / "active" / f"{validate_name(name)}.json"` (`hf_cache.py:226-227`).
- `state_root` hashes the canonical cache path under the user's state base (`hf_cache.py:131-134`) — **per-user state**; `apps/agent/src/inventory.ts:18-19` documents the same: registrations live "in **that user's** home (`~/.local/state/modelctl/hf-cache/<hash>`), so a root agent must list each cache owner separately (`runuser`)."
- Therefore resolution as root inspects root's empty cache while the data and registration live in operator's.

### 1.4 Options

| option | assessment |
|---|---|
| **A (recommended):** wrap `resolveModelPath` in the same ADR-0011 runuser shape as push | Mirrors the transfer path; `main.ts` already has `agentUser`, `cacheUser` (via `transport.getCacheUser()`, `main.ts:140`) and `resolveLocalUser` (`main.ts:146`) at hand. Missing per-user modelctl → fail with the push's actionable message instead of a bare banner. |
| B: resolve server-side from `node_models`/inventory | The inventory report carries no snapshot entrypoint and is cleared on job settlement (see 1.2); `node_models` proves presence, not a path. Stale-prone. Rejected. |
| C: chown caches to root / run scripts as cache user | Violates the per-user ADR-0011 posture and "never edits your scripts". Rejected. |

Note: the resolved `MODEL_PATH` (`/home/operator/.cache/...`) is consistent fleet-wide — every DGX node uses cache user `operator`, so the recipe's own worker SSH lands on the same path shape. The start script itself keeps running as the agent user (root can read the cache).

**Immediate owner workaround** (until fixed): uncheck `MODEL_PATH` in the setup env and let the script use its own path, or resolve manually — the model is startable today; only the resolution step is blind.

## 2. Wizard model selection: name vs "model_id"

- The catalog model has **no separate id**: `{ name, runtime, repository, bytes }` (`packages/core/src/catalog.ts:4-9`, modelctl catalog schema 3). The `name` **is** the model identifier.
- The wizard writes exactly that: choices come from `fetchModelsPage(1, q, "name")` and the radio sets `wizard.model = m.name` (`apps/web/src/components/ServeView.vue:384-391, 399-401, 767-773`).
- Every downstream consumer keys on that name: staging stages (`name: row.model`, `setups-service.ts:714-735`), `node_models` rows (`jobs-service.ts:508`), `modelctl path --local` record names (§1.3), and the DGX-3 inventory lists the registration under the same name the setup stores. The `repository` (`Mia-AiLab/…`) is HF provenance, used only as the chained-download `source`.
- **Conclusion:** the wizard is *not* selecting a wrong identifier — the observed failure is §1's cache-user bug, not a name/id mismatch.
- Real defects found while verifying:
  - The list is hard-truncated: `page.models.slice(0, 8)` (`ServeView.vue:387`) with **no scroll and no count** — matches beyond 8 are unreachable in the UI.
  - The whole wizard panel scrolls: `.wizard { max-height: 92vh; overflow: auto }` (`ServeView.vue:899-905`) with non-sticky header/footer on desktop (the sticky-foot pattern exists only in the mobile media query, `apps/web/src/assets/irori.css:326-327`).
  - Latent sharp edge (open, not today's failure): the chained-download stage passes `source: row.model` for store-absent models (`setups-service.ts`, download-queue stage) — valid only when the user typed a full HF repo id, despite the label admitting "catalog name or HF repo id". Whether modelctl's download queue accepts a bare name as `source` is **undetermined**; measure by reading `modelctl` `download_queue.py` `DownloadRequest` validation and running `modelctl queue` with a bare name against a scratch root.

## 3. Disk-hygiene clean CTA

- The CTA **exists**: `apps/web/src/components/CleanupDrawer.vue:272-289` — "type the node name to confirm" label, input bound to `confirmName`, and a `Clean N categories` button disabled until `confirmName === nodeName` and ≥ 1 category is checked (`:285-287`).
- Placement: inline **after** the five audit rows (`:218-270`) — each row can be tall (the staging row lists three orphaned paths of 60+ chars). The drawer is one scroll container: `.drawer { max-height: 88vh; overflow: auto }` (`irori.css:221-222`). Result: on the owner's viewport the confirm block is below the fold (screenshot shows the drawer parked on the rows) — **the CTA is invisible unless you scroll past all rows**, with no sticky affordance. The sticky-footer pattern the codebase already uses for the wizard on mobile (`irori.css:326-327`) is not applied here on desktop.
- Selection defaults are per design: safe categories pre-checked, care rows opt-in (`CleanupDrawer.vue:19`, `HYGIENE_SAFE_CATEGORIES`); the screenshot's checked "modelctl staging" (care) was user-selected.
- Minor nits observed: `1 items ∅ B` (no pluralization; a checked row showing `∅ B` reads as nothing-to-do), and long mono paths wrap without break-word tuning.

---

## Summary of Findings

1. **MODEL_PATH failure root cause:** the agent runs `modelctl path --local` as **root** while the staged model (and its modelctl registration) lives in the **cache user's** (`operator`) HF cache — the same per-user split every transfer already handles via the ADR-0011 runuser wrap. Fix = wrap resolution like push (option A); thread `cacheUser` + `resolveLocalUser` into `SetupDriver` deps. Verified by journal + successful resolution as operator on DGX-1.
2. **Wizard identifier:** correct as-is — the catalog `name` is the system-wide model key; no separate model id exists. The actionable defects are the 8-item no-scroll truncation and the whole-panel scroll. Open: download-queue `source` semantics for bare names.
3. **Hygiene CTA:** present but below the fold in a whole-drawer scroll container; fix = sticky confirm/CTA footer + copy nits.
4. **Open items:** (a) modelctl download-queue `source` with a bare catalog name — measure per §2; (b) whether DGX-2 truly holds the model in operator's cache — measure with `ssh dgx2 '/home/operator/.local/bin/modelctl path --local GLM-5.3-Flash-EXL3-4bpw-TensorFold-Ablit'`; (c) root's cache contents on DGX-1 are unverifiable without root (permission denied) — irrelevant: the journal proves root's resolution exited nonzero.
