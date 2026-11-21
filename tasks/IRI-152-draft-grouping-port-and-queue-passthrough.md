# Task: Irori — draft-kind grouping port, draftSpecType queue passthrough (IR-266 / IRI-152)

## Objective

The hub's `/api/v1/hf-quants` grouping matches modelctl ≥ 0.25.0 (IR-265):
- DSpark, DFlash and DFlash2 drafts are companions, not quants;
- imatrix files are hidden;
- a repo with several drafts defaults to the Q8_0 one;
- each candidate reports its draft kind.

A download carries an optional `draftSpecType` all the way to modelctl's queue
`draft_spec_type`. Epic IR-264; design in ADR-0020.

## Acceptance criteria

- [x] Grouping fixtures use the real lists for Inkling-2-Mini, unsloth
      gemma-4-26B and bartowski gemma-4-26B. flint-GGUF and gemma-4-31B
      results are unchanged.
- [x] Inkling: dspark files are excluded from quants. Default draft
      `dspark-…-Q8_0.gguf`, kind `dspark`.
- [x] Core, DB (migration 0029), dispatch and retry passthrough is tested, and
      the agent YAML pin includes `draft_spec_type`, emitted only when set.
- [x] `docs/API.md` and the CHANGELOG are updated, and ADR-0020 is added.
      `pnpm test`, the Postgres-backed server and db suites, and `pnpm build`
      are green.
- [ ] Live modelctl queue run with the bumped pin. Blocked on the v0.25.0
      release (IR-265). The pin is a hub settings row the operator sets in
      the UI or `PUT /api/v1/modelctl-pin`. The agent fallback default
      (`apps/agent/src/config.ts`, 0.23.0) deliberately stays, because pointing
      it at an untagged version would break installs.

## Implementation

- `apps/server/src/hf-quants.ts`: `draftKind`, `isDraftArtifact`,
  `isImatrixArtifact` and `isQuantExcluded` replace `isMtpArtifact`. Q8_0
  multi-draft default; `kind` on draft candidates.
- `packages/core/src/hf-quants.ts`: `HF_DRAFT_KINDS` and candidate `kind`
  (nullish).
- `packages/core/src/downloads.ts`: `DRAFT_SPEC_TYPE_RE` and `draftSpecType`
  on create, batch and entry.
- `packages/db`: `download_queue.draft_spec_type` plus migration
  `0029_download_draft_spec_type`.
- `download-queue-service.ts`: enqueue, batch and DTO; dispatch omits null.
- Agent `buildQueueYaml`: `draft_spec_type`, JSON-quoted.

## Validation evidence

- `pnpm -r typecheck` ✓.
- `pnpm test`: core 114, db 8 (+8 skipped), proxy 24, web 530, agent 321,
  server 268 (+180 PG-skipped).
- With `IRORI_TEST_DATABASE_URL` pointed at a fresh database in the local
  disposable `irori-test-pg`: db 16/16 and server 448/448, including the new
  draftSpecType dispatch and retry test.
- `.agentic/bin/docs-check` ✓ (after ADR-0020). `.agentic/bin/validate` ✓.

## Review

- **Security check:** PASS. `draftSpecType` comes from the authenticated
  download API. It's trimmed and checked against modelctl's regex before it
  reaches the DB, JSON-quoted in the agent YAML, and validated again by
  modelctl. The new code adds no endpoints or outbound fetches.
- **Independent review** (fresh read-only context): **PASS WITH FINDINGS**.
  - A differential run of the TS port against modelctl agreed on 26 tricky
    paths and 13 repo layouts.
  - F1: an older modelctl fails the whole batch when an entry carries
    `draftSpecType`. Documented in API.md and ADR-0020; the UI (IR-268)
    sends it only when it differs from the kind default.
  - F2: an older agent drops the field silently. Documented.
  - F3: a lone nested or non-f16 companion is modelctl's auto-pick but was
    reported as `null`. Fixed, with a test.
  - F4: edge-case path differences such as `mtp/.gguf` and backslashes, which
    real HF listings never contain. Accepted.
- **Residual risk:** there is no hub-side gate on the modelctl pin. Release
  modelctl 0.25.0 and set the pin before rolling out the hub.
