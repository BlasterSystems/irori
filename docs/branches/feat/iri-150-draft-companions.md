# Branch: feat/iri-150-draft-companions

Epic IR-264 (IRI-150): speculative draft companions for GGUF repositories.
Design: `tasks/research-gguf-draft-companions.md`, ADR-0020.

## 1. Business context

GGUF model repositories increasingly ship a small "draft" model for speculative
decoding next to the quantizations. Operators couldn't tell how to download it
together with the model:
- Irori listed unsloth's Inkling-2-Mini draft (`dspark-…-Q8_0.gguf`) as if it
  were a Q8_0 quantization;
- bartowski's gemma-4-26B (two drafts) couldn't be queued at all;
- the run command naming the draft often lives only on a linked docs page.

## 2. What changed

- **IR-266:** the download modal's quant listing (`/api/v1/hf-quants`) now
  treats MTP, DSpark, DFlash and DFlash2 files as drafts, never as quants. It
  hides `imatrix` calibration files, preselects the single root Q8_0 draft
  when a repo has several, and labels each draft candidate with its kind.
  Downloads can carry an optional draft spec type through to modelctl.

## 3. Business rules and constraints

- modelctl remains the only writer of the model store (ADR-0004). Irori only
  passes selections, and its grouping rules mirror modelctl ≥ 0.25.0 exactly.
- The draft spec type must match `^[a-z0-9][a-z0-9-]{0,31}$` at every layer.
  It's sent to modelctl only when set.

## 4. Edge cases handled

- Several root drafts with no single Q8_0 → no default; the operator must
  choose.
- Drafts in subfolders (`MTP/`, `dspark/`) are offered but never
  auto-picked.
- Older hubs, agents and clients without the new fields keep parsing (all
  new fields are nullish).

## 5. Integration impact

- **modelctl:** needs v0.25.0 (BlasterSystems/modelctl#14) for DSpark/DFlash
  selection and the `draft_spec_type` queue field. Set the hub's modelctl pin
  after that release.
- **Database:** migration 0029 adds the nullable
  `download_queue.draft_spec_type` column.

## 6. Out of scope and follow-ups

- IR-267: run hints from the README and allow-listed docs pages.
- IR-268: modal preselection and provenance UI.
- Drafts hosted in a separate repository (e.g. vLLM DFlash2 drafters).

## 7. Verification

- `pnpm -r typecheck`, `pnpm build`, `pnpm test` all green. With a disposable
  Postgres: server 448/448 and db 16/16.
- Grouping fixtures from real repo file lists (Inkling-2-Mini, unsloth and
  bartowski gemma-4-26B), mirrored by modelctl's `tests/test_drafts.py`.

## 8. Changelog

- 2026-11-21: IR-266: draft-kind grouping port, `draftSpecType` queue
  passthrough (migration 0029), ADR-0020.
