# Task: Download modal — draft preselection, kind labels, provenance, draftSpecType (IR-268 / IRI-154)

## Objective

The download modal's Expand panel makes the speculative draft obvious. It
preselects the draft the repo's own run instructions use (IR-267 hints), else
modelctl's default. It labels each candidate's kind, says where the choice came
from and which `--spec-type` it will serve with, and passes `draftSpecType` to
the queue when needed. Epic IR-264; ADR-0020.

## Acceptance criteria

- [x] Browser smoke in dark and light themes (headless Chromium driving the
      built server and the Vite dev server, 2026-11-21):
  - Inkling: DSpark Q8_0 preselected, "from docs · unsloth.ai" linked,
    `--spec-type draft-dspark`.
  - unsloth gemma-4-26B: root MTP preselected, "modelctl default", plus the
    model-card mmproj-BF16 note.
  - bartowski gemma-4-26B: MTP Q8_0 preselected, no imatrix row.
  - flint: "no speculative draft in this repo".
- [x] Uses DS v1.1 classes only (`field`, `select`, `stat__sub`, `bs-link`,
      `mono`). Web chrome pins are updated, and SPEC §6 is updated.
- [~] Queueing an Inkling row: the real `POST /api/v1/downloads` payload
      carried `{quantization: "Q4_K_XL", mtp: "dspark-Inkling-2-Mini-Q8_0.gguf"}`
      with no `draftSpecType`, since `draft-dspark` is the kind default. The
      resulting store entry (quant, mmproj and draft) needs modelctl v0.25.0
      on the NAS (IR-265 release), so it isn't verified yet.

## Implementation

- New `apps/web/src/draft-choice.ts` (pure, unit-tested):
  - `defaultDraftSpecType`, mirroring modelctl `default_spec_type`, legacy
    rules included;
  - `preselectDraft`: a hint that names a candidate, then the default, then
    none;
  - `draftSpecTypeToSend`: only for the hinted draft, and only when it
    differs from the default;
  - `effectiveDraftSpecType`, `draftKindLabel`, `hintProvenance`;
  - `safeHref`: https only;
  - `mmprojNote`.
- `ModelsView.vue`: the row model gains `draftSpecType`. The Expand panel uses
  the helpers; the label "MTP draft (companion)" becomes "Draft model".
  Submit sends `draftSpecType` when set.
- `apps/web/src/models.ts`: the wrapper input types gain `draftSpecType`.

## Decisions

- **mmproj hint is informational.** Rows and the download API have no mmproj
  field (modelctl auto-picks f16). Adding one is a new API field and DB
  column, outside this ticket. The panel shows a note instead when the model
  card's projector differs from modelctl's pick.
- **The spec type is sent rarely**, only when it differs from the kind default
  (review F1 on IR-266): modelctl ≤ 0.24.0 rejects the queue key batch-wide.
- **Plain rows are unchanged** (owner decision): no auto-expand and no default
  quant.

## Validation evidence

- `apps/web`: vue-tsc ✓, vitest 545 + 15 (`draft-choice.test.ts`) ✓, and the
  markup pins in `chrome-markup.test.ts` ✓.
- Smoke screenshots were kept in the session scratchpad (not committed).

## Review

- **Security check:** PASS.
  - Hint strings render only through Vue text interpolation (no `v-html`).
  - `href` is bound only via `safeHref` (https only), with
    `rel="noopener noreferrer"`.
  - `draftSpecType` comes only from a server hint already checked against
    `DRAFT_SPEC_TYPE_RE`, and the API schema validates it again.
- **Independent review** (fresh read-only context, headless-browser probes
  with intercepted POSTs): **PASS WITH FINDINGS**.
  - F1: with a non-https hint URL, the provenance label disappeared and the
    line read "from modelctl default". Fixed: the label always renders and
    is linked only if https. Verified in the browser and pinned.
  - F2: cross-row Expand race. A slow listing for repo A landed on row B with
    A's `mtp` and `draftSpecType`. The race predates this change, but the
    change made it worse. Fixed with a per-request staleness guard. A browser
    probe with A delayed 1.5 s shows B's own draft.
  - F3: the mmproj note claimed an explicit choice was needed when the repo
    has no projector candidates. Fixed: "modelctl will not download a
    projector".
  - F4: spec-type parity holds for `.gguf` paths; non-`.gguf` paths now fall
    back to `draft-mtp` like modelctl. The case is unreachable.
- **Accepted as is** (predate this change or are by design):
  - picking "Auto" drops the hint's override, by design ("manual choice");
  - an expanded row's source stays editable;
  - re-expanding doubles the name suffix.
- **Deploy notes:** web, hub and agent ship together on this branch. Release
  modelctl 0.25.0 (IR-265) and set the hub's modelctl pin first, so
  DSpark/DFlash selection and any `draft_spec_type` entries are understood.
