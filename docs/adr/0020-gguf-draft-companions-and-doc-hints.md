# ADR-0020: GGUF draft companions and allow-listed model-card run hints

- **Status:** Accepted
- **Date:** 2026-11-21
- **Decision owners:** Bruno Pires
- **Scope:** Model supply chain (download modal, `/api/v1/hf-quants`, download queue schema), hub outbound fetches
- **Tags:** supply-chain, gguf, modelctl, schema, security, integration
- **Supersedes:** None
- **Superseded by:** None

## Context

GGUF repositories ship speculative-decoding drafts next to their quantizations.
`unsloth/Inkling-2-Mini-GGUF` has `dspark-Inkling-2-Mini-Q8_0.gguf`, run with
`--model-draft … --spec-type draft-dspark`. Until now, modelctl
(`generation.py` `_is_mtp_artifact`) and its Irori port (`hf-quants.ts`) only
treated `mtp-*` files or files under `MTP/` as drafts. Other drafts were listed
as quantizations, could not be attached, and `modelctl serve-command` always
emitted `draft-mtp`. Repos with two root drafts, such as bartowski's
gemma-4-26B (`Q4_0` and `Q8_0`), could not be queued at all.

The run command that names the right draft and `--spec-type` is often not in
the repository. Inkling's README has none; it links to
`https://unsloth.ai/docs/models/inkling-2-mini`, which does.

The owner decided on 2026-11-21 (IR-264):
- change both modelctl and Irori;
- detect drafts from filenames, the repo README, and allow-listed linked docs;
- prefer a Q8_0 draft when there are several;
- leave a plain paste behaving as it does today.

## Decision drivers

- modelctl stays the only store writer (ADR-0004). Irori never resolves files
  itself, it only passes selections to modelctl.
- The hub's grouping must match modelctl exactly, or the modal offers
  selections modelctl refuses.
- Wire and storage changes are additive. Old hubs, agents and modelctl pins
  keep working, and existing objects keep their identity.
- A new outbound fetch from the homelab hub must not become an SSRF primitive,
  and must not leak the HF token.

## Considered options

### Option 1: download the draft as its own store entry

No modelctl change. But the draft is not linked to its model, and serving
can't pair them. Rejected.

### Option 2: a new `draft` companion key

It would make the naming explicit, but it breaks existing manifests, object
metadata, the queue `mtp` field (IRI-016) and the agent YAML contract, for no
user benefit. Rejected.

### Option 3: keep the `mtp` key, add draft kinds and an optional spec-type override (chosen)

Draft kinds by prefix or directory. An optional `draft_spec_type` is recorded
only when it differs from the kind default. Hints from the README and
allow-listed docs only ever preselect files that exist in the repo.

### Option 4: follow any link in the model card

It would catch the most cases, but it lets a repository author make the hub
fetch arbitrary URLs inside the homelab network. Rejected in favour of an
exact-host allowlist.

## Decision

1. **Draft contract (modelctl `drafts.py`, ported in `apps/server/src/hf-quants.ts`):**
   - A draft is a `.gguf` whose basename starts with `dflash2-` > `dflash-` >
     `dspark-` > `mtp-`, or that sits under a directory named
     `mtp|dspark|dflash|dflash2`.
   - Drafts and `*imatrix*` files are never quantization groups.
   - Default draft: the single root draft, else the single root Q8_0 draft,
     else an explicit choice.
   - The companion key stays `mtp`.
2. **Spec type:**
   - Defaults: `draft-dspark` for DSpark; none for DFlash; `draft-mtp` for
     everything else, including anything under `MTP/` and hand-written names,
     so legacy objects serve exactly as before.
   - An override is carried end to end as the optional `draftSpecType`
     (download API), `download_queue.draft_spec_type` (nullable column,
     migration 0029) and `draft_spec_type` (agent queue YAML, emitted only when
     set). It is validated against `^[a-z0-9][a-z0-9-]{0,31}$` at every layer
     and when modelctl serves.
3. **Run hints (`/api/v1/hf-quants` → `hints`):**
   - The hub parses `llama-server`/`llama-cli` snippets from the repo README,
     then from at most 3 README links on an exact-host allowlist
     (`huggingface.co`, `unsloth.ai`, `docs.unsloth.ai`; override with
     `IRORI_HF_DOC_HOSTS`).
   - Fetch rules: https only, port 443, no IP literals or userinfo; redirects
     are followed manually and only to allowlisted hosts, at most 2 hops; 5s
     per hop and a 10s budget per computation; 2 MiB streamed body cap;
     HTML/markdown/plain only. The HF token is sent only to `huggingface.co`.
   - Parsing is linear on adversarial input (repo authors control README
     text), with no backtracking-prone patterns, and a 2 MiB regression test
     enforces it.
   - A hint is kept only if it names a file in the repository's own listing.
     It is a UI preselection, never a new file. Failures never fail the
     listing.

## Consequences

### Positive

- DSpark and DFlash drafts download with their model and serve with the right
  flags. Multi-draft repos (bartowski) queue without manual input.
- Existing manifests, objects, queue YAML and older agents behave exactly as
  before.

### Negative

- Two ports of the draft rules (Python, TS) must stay identical. Fixture tests
  in both repos use the same real file lists.
- A repo whose `dspark-`/`dflash-` file used to be a separate "quant" entry now
  attaches it as a draft. Regenerating that manifest needs `force`.
- Doc-page scraping breaks if the page markup changes. Losing a hint only
  removes a preselection; filename rules still work.
- Version skew: the hub doesn't gate `draftSpecType` on the modelctl pin. An
  entry that carries it, dispatched to modelctl ≤ 0.24.0, fails its whole
  batch (unknown queue key), and an older agent drops it silently. Mitigation:
  clients send it only when it differs from the kind default (rare: DFlash
  with a hint). Release modelctl 0.25.0 and set the pin before rolling out
  the hub.

### Risks and mitigations

- SSRF through card links: exact-host allowlist, manual redirect checks, no
  IPs, a body cap, and no credentials to doc hosts (see `docs/SECURITY_AUDIT.md`).
- argv injection through a spec type: the regex rejects a leading `-` and
  whitespace at every layer and at serve time, and argv is built as a list.
- Drift between the ports: shared fixture lists, and the modelctl pin is bumped
  together with any rule change.

## Implementation and validation

- IR-265: modelctl PR (`drafts.py`, selection, serve, queue field) with
  pytest fixtures and a live `modelctl manifest` check against the three repos.
- IR-266: grouping port, schema and migration 0029, dispatch/retry
  passthrough, agent YAML; Vitest fixtures and a Postgres-backed queue test.
- IR-267: hints service and fetch-guard tests; security check.
- IR-268: modal preselection and provenance; browser smoke.

## Revisit triggers

- llama.cpp publishes a DFlash `--spec-type`. Add it to the kind defaults.
- A new draft naming scheme appears, or a repo uses `imatrix` in real quant
  names.
- A needed docs host outside the allowlist.

## References

- Research: `tasks/research-gguf-draft-companions.md`
- Jira: IR-264 (epic), IR-265 – IR-268
- ADR-0004 (modelctl-only store writes), ADR-0009 (server-side download queue)
- IRI-016 / IR-70 (multi-quant and MTP downloads)
