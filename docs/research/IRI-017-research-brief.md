# IRI-017 research brief — download-queue: manifest conflicts, progress + speed, HF token

- **Date:** 2026-10-22
- **Ticket:** IRI-017
- **Goal:** Three decision inputs for the download-queue work: (1) what modelctl's
  "manifest already exists with different settings" preflight failure means and how
  Irori should resolve it; (2) whether real per-entry download progress (bytes,
  percent, speed) can reach the web queue UI, and how; (3) how an HF token gets to
  the download path without violating the jobs no-credentials contract.

## 1. "Manifest already exists with different settings" — semantics and resolution

### 1.1 Where the error is raised and what is compared

Queue preflight, per entry, only when the manifest file already exists and the
entry did not set `force` (`modelctl/src/modelctl/download_queue.py:296-316`):

```python
path = root / "manifests" / f"{item.name}.yaml"
if not path.exists() or item.request.force:
    continue
...
if existing != item.document:
    errors.append(
        f"entry {index} ({item.name}): manifest already exists with "
        f"different settings at {path}; set force: true to replace it"
    )
```

The compared right-hand side is the freshly generated manifest document
(`generate_manifest_document`, `modelctl/src/modelctl/generation.py:242-343`).
Its full field set:

| Field | Source | Notes |
|---|---|---|
| `name` | explicit name or repo-tail infer | `validate_name` allows A-Z (`manifest.py:11`), so Irori's mixed-case names round-trip |
| `repo` | parsed HF id | |
| `revision` | the **requested literal** | bare `owner/model` → `"main"`; a `/tree/<sha>` URL pins the SHA. The resolved commit is **not** stored |
| `model_card` | `"README.md"` when present in the repo | `generation.py:289-291` |
| `format` | `safetensors` / `hf` / `gguf` | |
| `include` | exact file list (llama.cpp) or patterns (vllm) | vllm patterns from `_STANDARD_PATTERNS` (`generation.py:18-27`) |
| `entrypoint` | first selected GGUF shard | llama.cpp only |
| `runtime` | resolved `{type, executable}` | |
| `companions` | `{mmproj?, mtp?}` | llama.cpp only |

So `existing != document` is a full dict inequality: **any** drift in the repo
file list, the generating modelctl version's rules, or the requested settings
flips it. At execution the same check repeats
(`generation.py:380-406`); equal → reuse the manifest and proceed to
`update_model`; different without force → same error; force →
`write_generated_manifest(force=True)` → `os.replace` (`generation.py:362-366`).

The failing batch in the report was entry 4 of 8,
`GLM-5.3-Flash-EXL3-4bpw-TensorFold` (source `Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold`,
an EXL3/safetensors repo → vllm document shape). The hub dispatches **all**
pending rows as one batch (`apps/server/src/download-queue-service.ts:135-157`)
and modelctl preflights the whole batch before any download
(`modelctl/README.md:309-310`: "If any preflight check fails, the command exits
before writing manifests or downloading model data") — so **one conflicting
entry starves every other pending download**. The currently-running 1-entry
batch (hub job `486ac9a6-0404-41d6-8171-5eecc5f140af`, params `downloads: [{name,
source}]` only) confirms later dispatches run while conflicting rows sit pending.

### 1.2 Why the on-disk manifest differs (candidates, ranked)

1. **Generator-version drift** — manifests are a pure function of (repo files,
   requested settings, modelctl version). `modelctl/README.md` changelog notes:
   "The queue and full preflight workflow were added in `0.2.0`; model cards and
   GGUF companion discovery were added in `0.3.0`" (`README.md:1002-1005`).
   A manifest written by ≤0.2.x has no `model_card` key and no `README.md` in
   `include`; regenerating with 0.21.3 adds both → dict differs. `layout.py:58-60`
   explicitly comments "Keep object identities stable for pre-companion manifests".
2. **`_STANDARD_PATTERNS` evolution** — the vllm include set grew over time
   (today `*.json, *.safetensors, *.model, *.txt, *.tiktoken, *.jinja, *.py,
   *.vocab, *.merges, *.bpe`, `generation.py:18-27`); an older include list
   differs.
3. **Revision representation** — Irori dispatches bare `owner/model`, so the
   document pins `"main"`; a manifest once created from a `/tree/<sha>` URL
   stores the SHA.
4. **Upstream repo changed** — files added/removed on HF since the manifest was
   written change `include`/`entrypoint`.

**Missing evidence:** the exact diff for `GLM-5.3-Flash-EXL3-4bpw-TensorFold.yaml`.
SSH to the store node failed this session (`ssh nas` and `ssh root@nas` →
`Permission denied (publickey,password)`; the NAS agent uses its own outbound
WS transport). How to measure: read
`/mnt/llms/manifests/GLM-5.3-Flash-EXL3-4bpw-TensorFold.yaml` with the NAS
agent's SSH identity, or when the store node is idle run a one-off job, or
regenerate locally (`cd ~/Developer/modelctl && uv run modelctl manifest
"Mia-AiLab/GLM-5.3-Flash-EXL3-4bpw-TensorFold" --root /tmp/iri017`) and diff.
The resolution design below does not depend on which candidate fired.

### 1.3 Irori-side gap: `force` exists in the agent but is stripped upstream of it

- Agent **already supports** it: `DownloadEntry.force?: boolean` and
  `if (e.force === true) lines.push("    force: true")`
  (`apps/agent/src/modelctl.ts:33,60`; pinned by
  `apps/agent/test/m4.test.ts:14-28`).
- modelctl **already accepts** it: `force` is an allowed per-entry queue-YAML key
  (`download_queue.py:86-95`), parsed into `DownloadRequest.force` (`:26`,
  `:158-163`).
- The hub strips it: `downloadCreateSchema.pick({source, name, quantization, mtp})`
  (`packages/core/src/downloads.ts:31-34`), the `download_queue` table has no
  `force` column (`packages/db/src/schema.ts:250-273`), and the batch dispatch
  maps only `{source, name, quantization, mtp}`
  (`apps/server/src/download-queue-service.ts:150-157`).

### 1.4 Options

| Option | Mechanism | Tradeoff |
|---|---|---|
| **A. Per-entry opt-in force (recommended)** | add `force` to core schema, `download_queue` (migration 0016), dispatch mapping; modal checkbox + a "Retry with force" action on failed entries | Respects modelctl's guard; owner decides per entry. `os.replace` only swaps which document governs; blobs are content-addressed and `update_model` reuses valid published objects (`README.md:446`), so a same-content force re-activation is cheap |
| B. Always send `force: true` from Irori | one-line dispatch change | Silently overwrites deliberately-different manifests; defeats the modelctl guard. Reject |
| C. Hub-side conflict preview before enqueue | port manifest generation into the hub, compare against store manifests | Large; duplicates generation logic; the hf-quants port precedent exists but covers grouping only. Defer |

Because dispatch is all-or-nothing, A should also make the failure visible
per entry (today the preflight text lands on the batch job; the failed dialog
shows it, but rows only get the message via settleBatch fallback parsing).

## 2. Per-entry progress and download speed in the queue UI

### 2.1 What streams today (live evidence)

The running batch job's stored output frames (hub `GET /api/v1/jobs/486ac9a6-…`,
node NAS) and the job modal screenshot show the entire progress story:

```
preflight: validating store and 1 queue entries
[1/1] ready: Qwen3.8-Flash-Next-FP4-Local <- nvidia/Qwen3.8-Flash-Next-FP4-Local (safetensors)
preflight complete: starting 1 download(s), up to 1 concurrent
[dry-run] Fetching 32 files:   0%|          | 0/32 [00:00<?, ?it/s]
...
Fetching 32 files:  25%|█▎        | 8/32 [03:41<17:57, 44.91s/it]
```

- The bars come from `huggingface_hub.snapshot_download` inside modelctl
  (`modelctl/src/modelctl/hub.py:62-73`; the `[dry-run]` bars are the
  `dry_run=True` planning call in `estimate_snapshot`, `hub.py:28-53`).
- The tqdm unit is **file count** (`it/s`, `s/it`) — on large shards
  `44.91s/it` says nothing about bytes. No byte-level bar appears in the
  captured output at all.
- The agent splits `\r` repaints into separate frames and already throttles
  rsync `--info=progress2` lines to 1/s
  (`apps/agent/src/modelctl.ts:246-259`) — the hf bars (no `B/s`) are unthrottled.
- The agent does **not** pass `--json` to `modelctl queue`
  (`apps/agent/src/modelctl.ts:115-130`); `settleBatch` parses
  `[i/n] complete|failed` lines, with a `queue --json` results-document parser
  for pinned modelctl (`apps/server/src/download-queue-service.ts:196-231`).

### 2.2 Verified extension surface

Introspection against the modelctl venv (`uv run python -c …` in
`~/Developer/modelctl`):

```
version: 1.24.0
tqdm_class param: True
['repo_id', 'repo_type', 'revision', 'cache_dir', 'local_dir', 'library_name',
 'library_version', 'user_agent', 'etag_timeout', 'force_download', 'token',
 'local_files_only', 'allow_patterns', 'ignore_patterns', 'max_workers',
 'tqdm_class', 'headers', 'endpoint', 'dry_run']
```

`snapshot_download` accepts **`tqdm_class`** (progress hook) and **`token`**
(auth) — both unused by modelctl today (`hub.py:66-73` passes neither).

### 2.3 Options

| Option | Mechanism | Verdict |
|---|---|---|
| **A. Upstream modelctl progress events (recommended)** | modelctl (piresbruno/modelctl — owner repo) wraps `snapshot_download` with a custom `tqdm_class` that aggregates per-file byte bars and emits e.g. `progress: {"entry": n, "bytes_done": …, "bytes_total": …, "speed_bps": …}` JSONL on stderr at ≥500 ms cadence; agent frames forward it unchanged; the hub parses it on `download-queue` jobs and writes per-row columns (migration 0016: `bytes_done`, `bytes_total`, `speed_bps`); web renders bar + speed | Only option with real bytes/s. Requires a modelctl release + `IRORI_MODELCTL_PIN` bump (rides its own PR per owner convention) |
| B. Parse the existing tqdm lines agent/hub-side | regex the `it/s` bars | Reject: unit is file count, bytes never present, format is tqdm art |
| C. Poll staging dir size agent-side | `du -sb` delta/dt on the NAS staging dir; expected total from `estimate_snapshot` sizes | Fallback only: phase-blind, no clean end signal, extra polling machinery |

Interim cheap fix regardless: extend the existing agent throttle regex to the
hf bars (`it/s`/`s/it`) so the modal stops flooding
(`apps/agent/src/modelctl.ts:253-259`).

### 2.4 UI notes

- Rows: progress bar + speed chip on `running` entries; bar width transition
  (`ease`, ~0.6 s) so speed/percent changes animate smoothly; speed chip color
  buckets (muted → accent → success) keyed on the hub's `speed_bps` with the
  same transition — the "progressive animation on speed change" is a CSS
  transition on state change, `prefers-reduced-motion` respected (DS pulse
  precedent, `apps/web/src/assets/irori.css:156-158`).
- The modal keeps raw frames (or filters bar lines once structured events land).

## 3. HF token for downloads

### 3.1 How modelctl resolves auth

modelctl never passes a token parameter anywhere (repo-wide grep: no
`HF_TOKEN`, no `token=` on any huggingface_hub call; `hub.py` calls
`snapshot_download`/`HfApi` bare). Auth therefore follows huggingface_hub's
default resolution: the **`HF_TOKEN` environment variable**, `HF_TOKEN_PATH`,
or the cached token file from `hf auth login`
(https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables).

### 3.2 Transport constraint

Job params are documented credential-free ("Structured parameters (paths,
model names, flags — no credentials)", `packages/core/src/jobs.ts:48`) — they
land in Postgres rows, REST responses, and output frames. The token must not
ride job params.

### 3.3 Options

| Option | Mechanism | Verdict |
|---|---|---|
| **A. Token in the agent unit env (recommended)** | `HF_TOKEN=hf_…` (or `IRORI_HF_TOKEN` renamed to `HF_TOKEN` in `extraEnv`) on the agent systemd unit; `runStreaming` already merges `{...process.env, ...opts.env}` (`apps/agent/src/modelctl.ts:243`), so modelctl inherits it with **zero code**; `onJobRequest` currently passes no env (`apps/agent/src/main.ts:203-204`) | Token never enters DB/API; document in CONFIGURATION.md/DEPLOYMENT.md |
| B. `hf auth login` once per node | writes the cached token file | Zero-code manual fallback; invisible to Irori ops docs |
| C. Hub settings key distributed via job param | token in Postgres + API + frames | Reject: violates the jobs no-credentials contract; hub has no auth (homelab) |

Related gap, same pattern: the hub's hf-quants listing
(`apps/server/src/hf-quants.ts`) queries the public HF API unauthenticated, so
"Expand quants" fails with 401/403 on gated/private repos — an optional
server-side `HF_TOKEN` env (Authorization header) covers it later; not required
for downloads.

## Summary of Findings

1. **Manifest conflict:** the compare is full-dict equality between the stored
   manifest and a freshly generated document; `force: true` is an existing
   per-entry queue-YAML field that modelctl honors (`os.replace`) and the agent
   already emits — Irori's core schema, `download_queue` table, and dispatch
   strip it. Decision: option A (per-entry opt-in force + failed-row "Retry
   with force"), migration 0016. All-or-nothing preflight means one conflict
   blocks the whole batch. Exact cause for the GLM manifest is unverified
   (NAS SSH refused); measure per §1.2 — design does not depend on it.
2. **Progress + speed:** today only file-count tqdm bars stream as job frames
   (no bytes anywhere). hf_hub 1.24.0's `snapshot_download(tqdm_class=…)` is
   the verified hook; decision: option A — structured `progress:` JSONL emitted
   by modelctl upstream, hub-parsed into per-row byte/speed columns, CSS-
   transitioned bar + speed chip in the queue UI. Interim: throttle hf bars
   agent-side.
3. **HF token:** modelctl inherits huggingface_hub resolution; the agent child
   process already inherits the agent unit's env. Decision: `HF_TOKEN` on the
   agent unit (zero code, documented), never in job params (core contract).
   Optional hub-side token later for gated-repo quants listing.

Open items: exact NAS manifest diff (§1.2 measurement); whether modelctl's
upstream progress events land before or after the Irori columns (columns are
harmless pre-arrival).
