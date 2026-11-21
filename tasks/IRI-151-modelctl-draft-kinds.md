# Task: modelctl — DSpark/DFlash draft kinds, Q8_0 multi-draft default, per-kind --spec-type (IR-265 / IRI-151)

## Objective

modelctl recognises every in-repository speculative draft (MTP, DSpark, DFlash,
DFlash2) as the `mtp` companion. It never lists drafts or imatrix files as
quantizations, picks a sensible default when a repo has several drafts, and
serves with the right `--spec-type`. Delivered in the **modelctl** repo
(BlasterSystems/modelctl#14). Epic IR-264, design in
`tasks/research-gguf-draft-companions.md` and ADR-0020.

## Acceptance criteria

- [x] `unsloth/Inkling-2-Mini-GGUF --quantization UD-Q4_K_XL` → companions
      `mmproj-F16.gguf` and `dspark-Inkling-2-Mini-Q8_0.gguf`. `dspark/…-BF16` is
      not auto-picked. Serve uses `draft-dspark`, derived and not recorded
      (see Decisions).
- [x] `bartowski/google_gemma-4-26B-A4B-it-GGUF --quantization Q4_K_M` →
      `mtp-…-Q8_0` is auto-selected, and imatrix is not a quant group.
- [x] `unsloth/gemma-4-26B-A4B-it-GGUF` is unchanged.
- [x] Dflash serves `--model-draft` with no `--spec-type`. Legacy objects
      still serve `draft-mtp`.
- [x] The queue YAML accepts `draft_spec_type`, pytest is green, and the
      CHANGELOG and README are updated.
- [ ] Released as v0.25.0. This is an owner action after the PR merges;
      the Irori pin follows.

## Decisions

- **The spec type is not always recorded.** The ticket text said
  `speculative.spec_type: draft-dspark` in the manifest. Implemented instead as
  a flat `draft_spec_type`, written **only when it differs from the kind
  default**. Recording a derived value would change the object hash
  (`layout.object_path`), and would make re-queues of already-downloaded MTP
  models fail with "manifest already exists with different settings".
- **Legacy default.** `draft-mtp` stays the default for any path under `mtp/`
  and for names with no draft kind (review F1). Only DSpark and DFlash
  outside `MTP/` get new defaults.
- Shared rules live in the new `src/modelctl/drafts.py`, which avoids import
  cycles between generation, manifest, validation and operations.

## Validation evidence

- `uv run python -m pytest -q`: full suite green, including the new
  `tests/test_drafts.py` (kinds, selection, overrides, serve argv, legacy,
  tampered metadata, queue).
- Live: `modelctl manifest` against the three real repos gave the
  companions above (2026-11-21).
- Security check: PASS. The spec-type regex is enforced at generation, parse,
  `validate_object` and serve, and argv is built as a list.
- Independent review: round 1 **BLOCK** (F1, the legacy `--spec-type` loss);
  after the fix, round 2 **PASS WITH FINDINGS**. The remaining note: a DFlash
  file under `MTP/` keeps `draft-mtp`, by design, and `--draft-spec-type`
  overrides it.

## Review

- **Compatibility:** object identities are unchanged unless the new field is
  set, and metadata only gains an additive key. Upgrade note in the CHANGELOG:
  a former `dspark-`/`dflash-` "quant" entry regenerates differently and
  needs `--force`.
- **Residual risks:** a real quant file named with `imatrix` would be hidden.
  A substring `--mtp` value could now match DSpark/DFlash candidates too and
  become ambiguous. There is no "no spec-type" value for MTP/DSpark drafts.
- **Deploy notes:** merge PR #14, then tag `v0.25.0`
  (`semantic-versioning`), then set the Irori modelctl pin to 0.25.0.
