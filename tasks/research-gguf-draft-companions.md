# Research — auto-detect speculative draft companions (MTP / DSpark / DFlash / DFlash2) in GGUF repos

Working ID: **IRI-150** (epic, Jira [IR-264](https://blastersystems.atlassian.net/browse/IR-264)). Status: tickets created, ready for `implement`. IRI-149 skipped: likely to be taken by the in-progress IR-263. Date: 2026-11-21.

## Tracker target

- **Jira, project `IR`**, at `blastersystems.atlassian.net`. This came from the project files: earlier
  task files map local `IRI-<n>` to Jira `IR-<n>` (`tasks/IRI-016-…md:3` → IR-70,
  `tasks/IRI-148-…md:1` → IR-262), and `docs/DEVELOPMENT_PROCESS.md:105` sets the `IRI-<number>`
  convention.
- Jira overlap search ran 2026-11-21 (`draft|MTP|dspark|dflash|companion` in `IR`): no open overlap; only IR-70 (IRI-016, Done) is related.
- modelctl (`../modelctl`, separate repo): it's unclear whether its work is tracked in `IR`. See the
  open questions.

## Summary

Some GGUF repos ship a speculative-decoding draft next to the quants. Unsloth's Inkling-2-Mini runs
as `--model … --mmproj mmproj-F16.gguf --model-draft dspark-Inkling-2-Mini-Q8_0.gguf --spec-type
draft-dspark`. Neither modelctl nor Irori recognises non-`mtp-` drafts:

- the draft is listed as a **quantization**;
- asking for it explicitly fails;
- serving always says `draft-mtp`.

The owner wants the draft detected, from files, the README and linked docs, and auto-added to the
download. Owner decisions so far (2026-11-21):

- Change both modelctl and Irori.
- Detect from filenames + the repo README + allow-listed linked docs.
- Spec type: map it from the filename prefix, and let the README/docs override it. For dflash with
  no hint, emit no `--spec-type`.
- With several drafts, prefer Q8_0, otherwise ask.
- A plain paste (no Expand) keeps today's behaviour.

## Current state (evidence)

### modelctl (`../modelctl`, v0.24.0)
- Draft recognition is `mtp-` prefix or a `mtp` parent dir only (`src/modelctl/generation.py:105-110`).
- `_gguf_groups` skips only `mmproj*` and MTP files (`generation.py:120`). So `dspark-*.gguf`,
  `dflash-*.gguf` and `*-imatrix.gguf` all become quantization groups.
- `_select_mtp` only considers MTP-recognised candidates and auto-picks a single root-level one
  (`generation.py:208-216`). An explicit `--mtp dspark-…` therefore fails with "no mtp file matches"
  (`generation.py:162-164`). Several root candidates fail with "multiple companion files are
  available; pass --mtp" (`generation.py:186-190`).
- mmproj auto-pick is the single stem matching `(^|[-_.])f16([-_.]|$)` (`generation.py:196-205`). That
  rule already handles BF16/F16/F32 trios correctly, because `bf16` doesn't match.
- The manifest stores companions as `kind→path` (`generation.py:296-317`). Validation and serve read
  that map (`validation.py:256-262`, `operations.py:798-811`, `:940-959`).
- Serve always appends `--model-draft <mtp> --spec-type draft-mtp` (`operations.py:804-811`,
  `:953-959`).
- The queue YAML already carries `mtp` (`download_queue.py:32`, `:101`, `:170`).

### Irori
- The hub grouping port copies modelctl's rule: `isMtpArtifact` (`apps/server/src/hf-quants.ts:31-39`),
  exclusion (`:86`, `:127`), and the companion default (`:56-73`, root single = default).
- Contracts: `packages/core/src/hf-quants.ts:24-44`. Companions are `{mmproj, mtp}` with
  `candidates`/`default`, and nothing records a draft kind or spec type.
- Modal: `apps/web/src/components/ModelsView.vue:335-394`. `openExpand` preselects
  `companions.mtp.default`, and Expand rows carry `mtp` (`:391`). The label "MTP draft (companion)"
  is at `:1665`. Plain rows send `mtp` only when it's typed (`:399-424`).
- Queue passthrough of `quantization`/`mtp` runs core → DB → dispatch → agent YAML. It was delivered
  in IRI-016 (`tasks/IRI-016-…md`, migration 0015). The latest migration is
  `packages/db/drizzle/0028_bundle_sha256.sql`.
- Serving runs operator start/stop scripts (`apps/agent/src/setups.ts:268-280`), not modelctl serve.
  The spec type mainly matters for `modelctl serve` and the model card.

### Live repo evidence (HF API, 2026-11-21)
| Repo | Drafts | mmproj | Notes |
|---|---|---|---|
| `unsloth/Inkling-2-Mini-GGUF` (sha `ea0c79b`) | root `dspark-Inkling-2-Mini-Q8_0.gguf`, `dspark/dspark-…-BF16.gguf` | BF16/F16/F32 | `Mainline_Support/*.gguf_file` (not `.gguf`, already ignored). **The README has no llama-server snippet.** It links to `https://unsloth.ai/docs/models/inkling-2-mini`. |
| `unsloth/gemma-4-26B-A4B-it-GGUF` | root `mtp-gemma-4-26B-A4B-it.gguf` + `MTP/` ×3 | BF16/F16/F32 | Already works today once a quant is picked. |
| `bartowski/google_gemma-4-26B-A4B-it-GGUF` | root `mtp-…-Q4_0`, `mtp-…-Q8_0` | bf16/f16 | **Fails today** (two root drafts). `…-imatrix.gguf` is listed as a quant. |
| `meta-models/Muse-Glimmer-30B-GGUF` | `dflash-…Q4_K_M.gguf` | 1 | Already noted in `docs/research/IRI-016-research-brief.md:120-122`. |

The unsloth docs page is `text/html`, 200, with no redirect, and 1.43 MiB. It holds the snippet
6 times (`--spec-type draft-dspark`, `--mmproj Inkling-2-Mini-GGUF/mmproj-F16.gguf`, `--model-draft
Inkling-2-Mini-GGUF/dspark-…-Q8_0.gguf`). The **first snippet starts at byte ~501 900**, so a body cap
under ~1 MiB would miss or nearly miss it.

## Gap analysis

1. Only `mtp-*` files and `MTP/` folders count as drafts. dspark/dflash/dflash2 are misgrouped as
   quants in both repos.
2. Repos with several root drafts can't be queued without a manual pick, and Irori's UI leaves the
   pick empty → the modelctl run fails.
3. `imatrix` calibration files are offered as quants.
4. The spec type is hard-coded `draft-mtp`, so a dspark draft would be served wrong.
5. There's no card/docs reading. For Inkling, the authoritative run command lives **only** on an
   external docs page.

## Proposed design

The full step list is in the approved plan
(`~/.claude/plans/hashed-growing-hickey-of-7c064259-68de-4b1c-917c-d86cd473867a.md`). The decisions:

- **D1 — one draft rule, defined in modelctl and copied in Irori.**
  - `_draft_kind(path)`: basename prefix `dflash2-` > `dflash-` > `dspark-` > `mtp-`, or a parent dir
    `mtp|dspark|dflash`.
  - Drafts are excluded from quant groups.
  - Selection: an explicit substring wins → else the single root draft → else the single root Q8_0
    draft → else error.
  - `imatrix` basenames are excluded from groups.
  - The Irori port is pinned by fixture tests from the four repos above.
- **D2 — keep the companion key `mtp`.** It's the existing manifest, queue and DB contract. Add the
  optional manifest key `speculative: {spec_type}` and the queue/CLI field `draft_spec_type` /
  `--draft-spec-type`. Without it, derive from the kind: mtp→`draft-mtp`, dspark→`draft-dspark`,
  dflash*→none. For legacy manifests, serve still emits `draft-mtp` for an `mtp-` companion.
- **D3 — hub-side hints service** (`apps/server/src/hf-card-hints.ts`).
  - A pure `parseRunHints` over code blocks reads `--model/--mmproj/--model-draft/--spec-type`
    (handles `\` and PowerShell `` ` `` continuations, strips the `<repo-tail>/` prefix).
  - Sources, in order: the repo README (via `huggingface.co/{repo}/resolve/{sha}/README.md`), then
    up to 3 README links on an allowlisted host.
  - Hints are kept only if they resolve to a basename in the repo's file list. They are
    preselections, never new files.
  - Best effort: a failure sets `hints.error` and never fails the listing. Cached per `(repo, sha)`
    for 10 minutes.
- **D4 — UI.** Expand preselects `hints.draft` → `companions.mtp.default`. It shows the draft's kind
  and where it was detected, and carries `draftSpecType`. Plain rows don't change; modelctl's
  improved auto-select covers typed quants.

**Rejected:**
- **A draft as its own store entry.** It isn't linked to the main model, and serving can't pair them.
- **A new companion key `draft`.** It breaks existing manifests and the IRI-016 wire contract for no
  user benefit.
- **Fetching any linked host.** That's an SSRF surface from inside the homelab.
- **Auto-picking a default quant on paste.** The owner declined it.

**ADR required: yes (D3).** The hub fetches third-party documentation hosts, which is a new outbound
integration boundary and security-sensitive. The draft-kind/spec-type contract (D1/D2) lives in
modelctl and is recorded there. A note in Irori's ADR covers the dependency.

## Security analysis (D3)
- Allowlist is exact host match, https only: `huggingface.co`, `unsloth.ai`, `docs.unsloth.ai`. It's
  configurable through `IRORI_HF_DOC_HOSTS`. There's no IP literal, no userinfo, and port 443 only.
- `redirect: "manual"`. A redirect target is re-checked against the allowlist, with at most 2 hops.
- Each fetch has a 5s timeout and a **2 MiB** streamed body cap (raised from the plan's 512 KiB;
  see the evidence above). Only `text/html` / `text/markdown` / `text/plain` are accepted.
- The HF token is sent **only** to `huggingface.co`, never to doc hosts.
- The parsed text is never executed or rendered as HTML. Only basenames that match the repo's own
  file list, and a spec type matching `^[a-z0-9-]{1,32}$`, ever leave the service.
- It only runs on an authenticated operator Expand, so the only external trigger is the existing
  hub auth on `/api/v1/hf-quants`.
- `docs/SECURITY_AUDIT.md` gains an entry. `security-check` is mandatory on the D3 story.

## Implications
- **Schema:** one nullable column, `download_queue.draft_spec_type` (migration 0029). No backfill;
  rollback = drop the column (it only holds optional hints).
- **Interfaces:**
  - `/api/v1/hf-quants` adds `hints` and `candidates[].kind` (additive, nullish).
  - Download create/batch add the optional `draftSpecType`.
  - Agent YAML emits `draft_spec_type` only when it's set.
  - Docs: `docs/API.md`, SPEC §6.
- **Compatibility:** an older modelctl pin rejecting the unknown `draft_spec_type` key is
  [INFERENCE]: `download_queue.py:101` lists the allowed keys. Bump the pin
  (`packages/core/src/modelctl-pin.ts`) in the same change, and the agent only emits the key when
  it's set. Existing manifests behave the same.
- **Behaviour change:** repos whose dspark/dflash file was previously selectable as a "quant" (e.g.
  Muse-Glimmer's `dflash-…`) no longer list it as a quant, and a single root draft is now
  auto-attached. The live store entry `Muse-Glimmer-30B-GGUF-draft` stays as it is.
- **Deploy:** this affects hub, web and agent, plus a modelctl release and pin bump. It ships through
  `deploy-dev` → `deploy-prd` only when asked.
- **Tests:**
  - modelctl: pytest fixtures.
  - Irori: grouping fixtures (4 repos), `parseRunHints` (Inkling docs snippet, multi-line `\`,
    PowerShell, dflash), fetch-guard tests with a fake `fetchImpl` (allowlist, redirect-off-list,
    body cap, content type, no token to doc hosts), schema/DB/dispatch/YAML passthrough, web chrome
    pins.

## Phased delivery plan

**Epic IRI-150 ([IR-264](https://blastersystems.atlassian.net/browse/IR-264)) — Speculative draft companions for GGUF repos.** Stories are chained with Jira "Blocks" links: IR-265 → IR-266 → IR-267 → IR-268.

| # | Story | Repo | Depends on | Acceptance criteria |
|---|---|---|---|---|
| S1 — IRI-151 [IR-265](https://blastersystems.atlassian.net/browse/IR-265) | Draft kinds, multi-draft Q8_0 preference, imatrix exclusion, `speculative.spec_type` + correct serve flags | modelctl | — | Inkling: `manifest … --quantization UD-Q4_K_XL` → companions `mmproj-F16.gguf` + `dspark-…-Q8_0.gguf`, `spec_type: draft-dspark`. Bartowski gemma: auto `mtp-…-Q8_0`, imatrix not a group. Dflash: no `--spec-type`. Legacy `mtp-` manifests still serve `draft-mtp`. Released as a minor version. |
| S2 — IRI-152 [IR-266](https://blastersystems.atlassian.net/browse/IR-266) | Grouping port + contracts + `draft_spec_type` passthrough + pin bump | Irori | S1 | `/hf-quants` for the 4 repos matches S1 (fixture tests). Migration 0029. Dispatch/retry carry the field. Agent YAML pin. The pin bump passes modelctl preflight in a live queue run. |
| S3 — IRI-153 [IR-267](https://blastersystems.atlassian.net/browse/IR-267) | Card + allow-listed docs hints service, ADR, security audit entry | Irori | S2 | Inkling `/hf-quants` → `hints.draft = dspark-…-Q8_0.gguf`, `specType = draft-dspark`, `source = docs`, `url = unsloth.ai/docs/models/inkling-2-mini`. All fetch guards are covered by tests. `security-check` is clean. ADR is Accepted. |
| S4 — IRI-154 [IR-268](https://blastersystems.atlassian.net/browse/IR-268) | Modal: draft preselect, kind badge, provenance line, `draftSpecType` on Expand rows | Irori | S3 (S2 for the badge) | Browser smoke for Inkling, both gemma repos and flint-GGUF (no change). Labels follow DS v1.1. Web tests updated. |

S2–S4 could ship as one Irori PR if the owner prefers. S1 must be released first.

## Risks and open questions
1. **modelctl tracking:** resolved. S1 is IR-265 in `IR`, labelled `modelctl`.
2. **DFlash/DFlash2 spec type for llama.cpp is unverified.** No live llama.cpp dflash snippet was
   seen. Default: emit no `--spec-type` unless the README/docs give one (owner decision).
3. **Docs page drift.** Unsloth's GitBook markup can change, and the parser looks at text content,
   not DOM structure. Default: a failure only drops the hint; filename rules still work.
4. **Allowlist breadth.** Should `github.com` README links count? Default: no, until a repo needs it.
5. **Draft-in-a-subdir choice** (Inkling's `dspark/…-BF16`) is offered in the dropdown but never
   auto-picked. Default: keep it that way.

## Overlap findings
- **IRI-016 / IR-70** (done): it built the queue `mtp` passthrough, the Expand flow and the grouping
  port this epic extends. It explicitly deferred "`dflash-`/`mtp-`-as-entry cases stay manual"
  (`tasks/IRI-016-…md`, Excluded). This epic is that follow-up, done as linked companions.
- **IRI-006 / IRI-028**: vLLM DFlash2 drafters (`incoai/GLM-5.3-Flash-DFlash2`) are **separate
  safetensors repos** passed as `--drafter`. They're out of scope here (same-repo GGUF only).
- **Jira search (2026-11-21):** no open duplicates in `IR`.
  `companion`) before creating tickets.
