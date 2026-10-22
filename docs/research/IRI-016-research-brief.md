# IRI-016 research brief — GGUF multi-quantization + MTP downloads, and download-modal UI review

- **Date:** 2026-10-21
- **Ticket:** IRI-016
- **Goal:** What must change so the "Download from HF to NAS" modal can land a single HF
  repo containing many GGUF quantizations (and MTP/mmproj artifacts) into the store the
  way modelctl already models it; plus the owner-requested review of the modal's
  spacing/UI and the "Add 0 to queue" CTA.

---

## 1. How modelctl models a multi-quant GGUF repo

**One entry per quantization.** Each quantization becomes its own model (own manifest
YAML, own object directory, own catalog entry). There is no "repo with quants" object.

Grouping — `src/modelctl/generation.py:112-143` (`_gguf_groups`):

- Shard pattern `^(?P<base>.+)-(?P<index>\d{5})-of-(?P<count>\d{5})\.gguf$`
  (`generation.py:13-15`, case-insensitive). Groups key on `(parent_dir, base, count)`
  — **per-quant subdirectories are part of the key and work**.
- Files skipped from grouping: `mmproj*` basenames and MTP artifacts
  (`generation.py:117-119`) — they are companions, not quantization groups.
- An incomplete shard set aborts with the missing indices (`generation.py:138-141`).

Selection — `generation.py:218-239` (`_select_gguf`):

- `--quantization` is a **case-insensitive substring match on the file basename**
  (`needle in Path(value).name.lower()`), not an exact tag.
- With no `--quantization` and more than one group: hard error listing up to 6
  candidates (`generation.py:233-238`).

Validation enforces exactly one quantization per entry — `validation.py:133-135`
("GGUF include patterns must select exactly one quantization"), `validation.py:164-178`
("GGUF include patterns selected additional quantizations: …"). GGUF + vLLM is refused
(`manifest.py:154-157`); GGUF runtime is always `llama.cpp` / `llama-server`
(`manifest.py:55-58`).

Transfer downloads **only the selected files**: `hub.py:35-42` and `hub.py:66-71` pass
`allow_patterns=list(manifest.include)` to `snapshot_download` — the unselected quants
are never fetched.

Naming: `name` defaults to a slug of the repo tail (`flint-GGUF` → `flint-gguf`), so
two quants of one repo **collide** unless each entry gets an explicit name; the queue
preflight rejects duplicates with "Set a unique 'name' for every quantization or draft
model" (`download_queue.py:193-199`). CLI docs state the same
(`cli.py:723-724`: "If multiple GGUF quantizations exist, --quantization is required.";
`cli.py:766-770` queue example: same source twice, `name: model-q4`, `quantization: Q4_K_M`).

**Transcript** (modelctl @ repo HEAD, 2026-10-21, against `unsloth/flint-GGUF`):

```
$ modelctl manifest unsloth/flint-GGUF --output /tmp/iri-flint/no-quant.yaml
  rc=1
  modelctl: multiple GGUF quantizations are available; pass --quantization.
  Candidates: flint-preview-BF16-00001-of-00003.gguf, flint-preview-Q8_0.gguf,
              flint-preview-UD-IQ1_M.gguf, flint-preview-UD-IQ2_XXS.gguf,
              flint-preview-UD-IQ3_XXS.gguf, flint-preview-UD-Q2_K_XL.gguf

$ modelctl manifest unsloth/flint-GGUF --quantization UD-Q4_K_XL --output …/q4.yaml
name: flint-gguf
repo: unsloth/flint-GGUF
revision: main
model_card: README.md
format: gguf
include:
- flint-preview-UD-Q4_K_XL.gguf
- README.md
entrypoint: flint-preview-UD-Q4_K_XL.gguf
runtime:
  type: llama.cpp
  executable: llama-server

$ modelctl manifest unsloth/flint-GGUF --quantization bf16 --output …/bf16.yaml
include:
- BF16/flint-preview-BF16-00001-of-00003.gguf
- BF16/flint-preview-BF16-00002-of-00003.gguf
- BF16/flint-preview-BF16-00003-of-00003.gguf
- README.md
entrypoint: BF16/flint-preview-BF16-00001-of-00003.gguf
```

Note the `bf16` case: lowercase substring matched the sharded set inside the `BF16/`
subfolder, include paths carry the subdirectory, entrypoint is shard 1.

## 2. MTP and mmproj companions

Rules — `generation.py`:

- MTP artifact = `.gguf` whose basename starts `mtp-` **or** any parent dir is `mtp`
  (`_is_mtp_artifact`, `generation.py:103-108`).
- mmproj default: the single file matching `f16` (`_select_mmproj`); MTP default: the
  single **root-level** `mtp-*` file (`_select_mtp`); ambiguous → error demanding
  `--mmproj`/`--mtp` (`_select_artifact`).
- Companions ride along in `include` and land in the manifest `companions` map
  (`generation.py:293-306`).

Serve wiring — `operations.py:766-783`: for `llama.cpp`,
`llama-server --model <entrypoint> --mmproj <mmproj> --model-draft <mtp> --spec-type draft-mtp`.

**Transcript** (`unsloth/gemma-4-31B-it-GGUF`, the owner's example):

```
$ modelctl manifest unsloth/gemma-4-31B-it-GGUF --quantization UD-Q4_K_XL --output …
companions:
  mmproj: mmproj-F16.gguf          # auto: exactly one f16 among BF16/F16/F32
  mtp: mtp-gemma-4-31B-it.gguf     # auto: single root-level mtp-*.gguf

$ modelctl manifest … --quantization UD-Q4_K_XL --mtp MTP/mtp-gemma-4-31B-it-Q8_0.gguf
companions:
  mmproj: mmproj-F16.gguf
  mtp: MTP/mtp-gemma-4-31B-it-Q8_0.gguf   # explicit override wins
```

So MTP support per entry = an optional `mtp` string on the queue entry; **the agent and
YAML builder already have it** (`apps/agent/src/modelctl.ts:33`, emitted at `:60`).

Edge cases observed on HF:

- `meta-models/Muse-Glimmer-30B-GGUF` ships a draft named `dflash-…Q4_K_M.gguf` — **not**
  recognized as an MTP artifact (no `mtp-` prefix/dir), so it groups as a quantization of
  its own. The live store reflects this: `Muse-Glimmer-30B-GGUF-draft` is its own entry.
- The live store also contains `gemma-4-12b-it-mtp-q8-0` (an entry per MTP-quantized
  draft). Under current modelctl rules an entry like that cannot come from
  `--quantization` (MTP files are excluded from groups) — it must have been created via a
  manual manifest or older tooling. Implication: the UI should treat "download the MTP
  draft as its own entry" as an explicit user action, not an automatic one.
- `MTP/README.md` exists inside the `MTP/` dir — non-GGUF, ignored by grouping, but a
  listing UI must filter to `.gguf`.

## 3. Real repo layouts (HF API, 2026-10-21)

| Repo | Quant groups | Sharded? | Subdirs | mmproj | mtp files |
|---|---|---|---|---|---|
| `unsloth/flint-GGUF` | 10 (9 root + BF16) | BF16 only (3 shards) | `BF16/` | 0 | 0 |
| `unsloth/gemma-4-31B-it-GGUF` | 22 (21 root + BF16) | BF16 (2 shards) | `BF16/`, `MTP/` | 3 (BF16/F16/F32) | 4 (root + 3 in `MTP/`) |
| `unsloth/Qwen3.5-122B-A10B-MTP-GGUF` | 15, **all** sharded | yes (3–5 shards) | one dir per quant | 0 | 0 (repo name only) |
| `meta-models/Muse-Glimmer-30B-GGUF` | 3 (+1 dflash draft) | no | — | 1 | 0 (`dflash-` prefix) |

Other facts: `imatrix_unsloth.gguf_file` stubs don't end `.gguf` → ignored; per-file
sizes are available from `GET /api/models/{repo}?blobs=true` (all 12 flint files sized;
at least one shard returned size 0 — display sizes only when > 0).

## 4. Live store state (hub 10.20.30.9:3947, dev-0.3.0-18)

`curl /api/v1/models` (all 5 pages, 132 entries): **19 repositories have multiple
entries.** Every multi-quant GGUF repo is stored as one entry per quantization —
modelctl's model is already the store's reality. Examples:
`unsloth/DeepSeek-V4-Flash-0731-GGUF` → `…-Unsloth-UD-Q4_K_XL` + `…-Unsloth-UD-Q8_K_XL`;
`unsloth/Qwen3.6-27B-MTP-GGUF` → 3 entries; `unsloth/gemma-4-12b-it-GGUF` → 3 entries
(incl. the separate `…-mtp-q8-0` draft entry).

Entry naming is **inconsistent** (manual CLI downloads): mixed case and separators
(`…-UD-Q4_K_XL`, `…-ud-q4-k-m`, `…-Q4-K-M`). A UI-derived convention ends this drift.

## 5. Irori pipeline audit — where quantization is dropped today

Data path: web rows → `POST /api/v1/downloads` → `download_queue` table → dispatch →
agent YAML → modelctl queue. The tail already supports quantization; the front drops it:

| Stage | State | Evidence |
|---|---|---|
| Web rows | `{id, source, name}` only | `ModelsView.vue:116`, submit maps `{source, name}` at `:149` |
| Core zod | batch schema picks `{source, name}` — unknown keys stripped | `packages/core/src/downloads.ts:26-31` |
| DB | `download_queue` has no quantization/mtp columns | `packages/db/src/schema.ts:250-269`; migration `0011_download_queue.sql` |
| Server dispatch | maps rows to `{source, name}` only | `apps/server/src/download-queue-service.ts:147-151` |
| Agent `DownloadEntry` | `quantization`, `runtime`, `mmproj`, `mtp`, `force` all supported; YAML-escaped | `apps/agent/src/modelctl.ts:24-66`; test pin `apps/agent/test/m4.test.ts:16-26` |
| modelctl | verified §1–2 | — |

IRI-015 explicitly deferred this: *"Per-entry advanced fields
(revision/quantization/runtime/mmproj/mtp) in the modal (agent/YAML builder already
supports them; UI later)"* (`tasks/IRI-015-bulk-download-modal.md`, Excluded).
Settle/reconcile is name-keyed (`download-queue-service.ts:214-236`) — unaffected by
adding fields.

## 6. Adaptation options

| Option | Mechanism | Tradeoffs |
|---|---|---|
| **A. Manual field only** | Add optional "Quantization" (and "MTP") text inputs per row; pass through core→DB→dispatch. | Smallest change; user must know exact tags; no discovery of what a repo contains; substring semantics forgiving (case-insensitive). |
| **B. Expand on parse (recommended)** | A + a hub endpoint `GET /api/v1/hf-quants?repo=…` that calls the public HF API (`/api/models/{repo}?blobs=true`) and ports `_gguf_groups` to TS (~40 lines: shard regex, skip mmproj/mtp, key `(dir, base, count)`). UI: per-row "Expand quants…" → checkbox list (tag, size GiB, sharded) → expands to N rows named `{repo-tail}-{TAG}` with `quantization: TAG`; MTP variants offered as a per-row dropdown when present. | Instant UI, no agent round-trip, no modelctl change. Cost: grouping logic duplicated in TS — pin it with fixture tests using the real flint/gemma-4-31B file lists from §3 so drift vs modelctl is caught. Server needs outbound internet (hub is in docker on 10.20.30.9; it already reaches npm/GitHub at build; homelab has no gated repos). |
| **C. New read-only modelctl verb** (e.g. `modelctl quants OWNER/MODEL --json`) | Agent executes it as a job. | Precedent exists (IRI-015 added `queue --json`, released v0.21.0); no logic duplication. Costs: one-active-per-node job slot contention with downloads, slower round-trip, owner release + pin bump on every node. |

Recommendation: **B**. Keep modelctl as the execution engine untouched; the listing is
read-only and the grouping port is pinned by tests. Tag→needle rule for B: use the exact
distinguishing token from the basename (e.g. `UD-Q4_K_XL`, `Q8_0`); if a tag is a
substring of another group's name, widen it (e.g. `UD-Q4_K_M` when plain `Q4_K_M` also
exists) — modelctl errors with "multiple GGUF quantizations" otherwise.
Batch cap is 50 entries (`downloads.ts:22-23`): flint (10) + gemma-4-31B (22) +
Qwen3.5-122B (15) = 47 fits, but several expanded repos can exceed — enforce/trim in the
UI before submit. Default names `{repo-tail}-{TAG}` (tag verbatim) match the store's
readable entries; dedupe rows on `(source, quantization)` after expansion.

Pipeline changes for B+A (shared): core `downloadCreateSchema` + batch pick gain
optional `quantization: string` and `mtp: string` (both `.trim().min(1)` optional);
`toDownloadDto`/rows carry them; **db migration 0015** adds nullable `quantization`,
`mtp` text columns to `download_queue`; `dispatchIfIdle` passes them through
(`download-queue-service.ts:149`); retry keeps stored values. Agent: no change.

## 7. Download-modal UI review (measured on live hub dev-0.3.0-18, viewport 1365 px)

Findings, with pixel evidence (bounding rects + computed styles):

- **F1 — `.hytable` is a dead class.** Used 4× in `ModelsView.vue` (models list :356,
  queue :390, placement :429, modal rows :530) and defined **nowhere** (repo-wide grep;
  mockups use `.table`). Live computed: `th/td padding: 1px`, `border-collapse:
  separate`, no header treatment → all four tables render as raw browser tables. Fix:
  use the DS `.table` (mockups' canonical, `Design System` `.table th` 8/12px + mono
  uppercase headers).
- **F2 — no vertical rhythm between field groups.** `.field` blocks stack flush:
  field1 bottom 413 = field2 top 412; field2 bottom 499 = field3 top 499; field3 bottom
  558 = footer top 559. All perceived separation comes from inline hacks
  (`style="margin-top: 6px"` on Parse rows; `margin: 4px 0 0` helper; `margin-top: 4px`
  table). The DS scale (`--space-1..7`, iroiri.css `:40-44`) is unused here.
- **F3 — "Parse rows" stretches full width (730 px).** It is a grid item of `.field`
  (display: grid), so the secondary button renders as a full-width bar (screenshot),
  reading as primary. Should be `justify-self: start` (and the 11 px gap it currently
  gets — 6 px inline margin + 5 px grid gap — collapses to the grid gap).
- **F4 — CTA "Add 0 to queue".** Disabled at 0 rows (opacity .5) but shows the count
  `0`; the count is already in the section header ("Downloads to queue (0)"). Options:
  (a) label `Add to queue` when 0, `Add N to queue` when N > 0 — recommended, stable
  layout, no zero; (b) hide the CTA until rows exist; (c) static label + count chip.
  Also consider regular `.btn` (34 px) instead of `btn--sm` (28 px) for the modal's
  primary action.
- **F5 — "Parallel jobs" input is 730 px wide** for a 1–16 integer. Cap at ~8–10 ch.
- **F6 — rows table density.** After parse: row height 34 px, inputs 32 px, `td`
  padding 1px (F1) → inputs jammed edge-to-edge, no hover affordance; `.table` fixes it.
- **F7 — modal width.** Scoped override `.drawer { width: min(760px, 100%) }`
  (ModelsView scoped style) vs global 560 px; consistent with ServeView overrides, keep.

## Open questions

1. Does any DGX node have `llama-server` installed? Downloads need no runtime, but
   serving the resulting GGUF entries does (`operations.py:766-783`). The llm-probe
   already detects llama.cpp backends (`apps/agent/src/llm-probe.ts:426-435`), so the
   telemetry side is ready either way. Not blocking IRI-016.
2. Jira ticket for IRI-016 not yet created (task file says "none yet", IRI-015
   precedent).
3. If the hub ever loses outbound internet, option B's endpoint fails — degrade to
   manual quantization entry (option A path) with an error banner.

## Summary of Findings

1. **modelctl already fully supports multi-quant GGUF + MTP**: one entry per
   quantization (`--quantization` substring on the basename, shard-aware, subfolder-aware),
   MTP/mmproj as auto-selected companions with explicit override, serve wired via
   `--model-draft --spec-type draft-mtp`. Verified live against `unsloth/flint-GGUF` and
   `unsloth/gemma-4-31B-it-GGUF`.
2. **The store already holds multi-quant repos this way** (19 multi-entry repos on the
   live hub). Nothing about the store or ADR-0004 changes.
3. **The gap is Irori's front half**: web rows, core zod schema, DB columns, and server
   dispatch all strip `quantization`/`mtp`; the agent YAML builder already emits them.
   IRI-015 deferred exactly this to "UI later" — this is that task.
4. **Recommended adaptation**: optional `quantization` + `mtp` per row end-to-end
   (migration 0015) + "Expand quants" powered by a hub-side HF-API listing with a
   test-pinned TS port of modelctl's grouping; default names `{repo-tail}-{TAG}`;
   dedupe on `(source, quantization)`; respect the 50-entry batch cap.
5. **Modal UI**: replace dead `.hytable` with DS `.table`; give field groups real
   spacing (`--space-3` stack) instead of inline margin hacks; stop stretching "Parse
   rows"; CTA reads "Add to queue" at 0 rows / "Add N to queue" when N > 0; narrow the
   Parallel jobs input.
