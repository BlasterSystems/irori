# Task: IRI-155 / IR-269 — Models: show draft and mmproj companions; remove the Runtime column

Ticket: [IR-269](https://blastersystems.atlassian.net/browse/IR-269) (Story, relates to IR-264).
Research: `tasks/research-model-detail-companions.md`. Contract: ADR-0020 (companions), ADR-0004 (read-only store).

## Objective

After a GGUF download, Irori shows which mmproj projector and speculative draft were installed with a
model: rows in the Models detail drawer, a `+draft` / `+mmproj` chip on list rows. The Runtime column
leaves the Models list.

## Product manager summary

- **One-liner:** The Models page shows each model's installed draft and projector companions.
- **User value:** No NAS shell (`.modelctl.json`, `modelctl serve-command`) needed to see what a model serves with.
- **Business impact:** Closes the loop on IR-264 (companions selectable and downloadable but invisible afterwards).
- **Success metric:** On dev, `Inkling-2-Mini-GGUF-Q4_K_XL` shows `mmproj-F16.gguf` and the DSpark draft with `--spec-type draft-dspark`.
- **Dependencies & constraints:** The NAS agent must run the new bundle; until then rows are absent.

## Acceptance criteria

- [ ] The agent catalog frame carries `companions`, read from the active object's `.modelctl.json`: bounded (2 s, ≤ 1 MiB, concurrency 8), confined to the store; no metadata file → `null`; any other read failure → `{unreadable: true}`; never a failed catalog.
- [ ] (Owner, 2026-11-21) Unreadable shows an ⓘ marker labelled "Cannot read the model's companion info from the NAS" in the drawer and the list row, replacing any earlier value.
- [ ] The hub merges `companions` into `model_meta.meta` on insert and update; a frame without the field preserves the stored value.
- [ ] `/api/v1/models` rows expose `companions`; older hubs and clients keep parsing.
- [ ] The drawer shows `projector` and `draft` rows (kind, file, size, effective `--spec-type`) only when present.
- [ ] List rows show `+draft` / `+mmproj` chips only when present.
- [ ] The Runtime column is removed (header and cells); the runtime filter chips and the drawer chip still work.
- [ ] Tests: agent (Inkling-like object, legacy without metadata, malformed JSON, symlink escape, size cap, timeout); core back-compat; server insert/update/preserve against PG; web helpers and markup pins.
- [ ] Live on dev after deploy (owner-run deploy): Inkling shows both companions; a vLLM model shows none.
- [ ] Docs: API.md, SPEC §6, CHANGELOG.

## Scope

### Included

- Agent metadata read, wire field, hub merge, API field, drawer rows, list chips, Runtime column removal.

### Excluded

- Per-node local cache (`hf-cache`) companions (research risk 4).
- The pre-existing `scanStore` relative-symlink resolution (see Review → residual risks).

## Implementation plan

### Files to modify or create

- `packages/core/src/catalog.ts`: `storeCompanionsSchema`, `storeModelSchema` (wire entry = catalog model and optional `companions`); `ScannedModel` derives from it. `catalogModelSchema` (modelctl `catalog.json` parsing) is unchanged, so a future modelctl field can't break catalog parsing.
- `packages/core/src/hf-quants.ts`: `draftKind` moves here (pure) so web can label a draft; server re-exports.
- `packages/core/src/job-messages.ts`: `catalogMsgSchema.entries` uses `storeModelSchema`.
- `packages/core/src/model-api.ts`: `modelEntrySchema.companions` optional.
- `apps/agent/src/catalog-read.ts`: `readCompanions`, `withCompanions` (limited concurrency), applied on both catalog and scan paths.
- `apps/server/src/jobs-service.ts` (`onCatalog`), `apps/server/src/hub.ts` (type), `apps/server/src/app.ts` (`/api/v1/models` lifts `meta.companions`).
- `apps/web/src/model-companions.ts` (new, pure), `apps/web/src/components/ModelsView.vue`.
- Docs: `docs/API.md`, `docs/SPEC.md` §6, `CHANGELOG.md`.

### Key changes

- Wire states: absent = unknown (an older agent; the hub keeps what it stored); `null` = known, none; `{unreadable: true}` = the read failed, and it replaces the stored value (owner decision, 2026-11-21: the page never shows companions it couldn't confirm on the last read).
- The agent validates every companions value with the shared zod schema before sending. An invalid entry would otherwise make the hub drop the WHOLE catalog frame.
- Confinement through `realpath`: the object dir must resolve inside `realpath(root)`. The metadata file is opened with `O_NOFOLLOW`, fstat'd as a regular file ≤ 1 MiB, and read with a byte cap. Companion paths must be relative, without `..`, `\`, or NUL.
- The hub merges with jsonb `meta || {"companions": …}` only when the frame carries the field.

### Test approach

- `apps/agent/test/catalog-companions.test.ts`: temp stores.
- `packages/core/test/catalog.test.ts`: schema back-compat.
- `apps/server/test/job-events.test.ts`: PG merge/preserve; app route test for the lift.
- `apps/web/test/model-companions.test.ts`, and a markup pin in an existing ModelsView markup test.

## Plan

- [x] Run the confidence-check readiness gate
- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Readiness (confidence-check, 2026-11-21)

- Requirements: clear; owner gate decisions recorded in the research brief. **Correction to the brief:** the `colspan="5"` it cites (`ModelsView.vue:1658`) belongs to the download modal's table, not the Models list. The Models list has no colspan, so there is nothing to fix.
- Impact: four packages, one additive optional field end to end. Old hub with new agent: zod strips the field. New hub with old agent: the field is absent and stored data is preserved.
- Tests: planned per layer, above.
- Security: new file read from the NAS store (confinement, size cap, no symlink follow on the metadata file, path validation, strict schema). Rendered with Vue text interpolation only.
- Data isolation: the model catalog is fleet-global (single-tenant homelab); no scoped queries touched.
- Rollback: revert the commit. The stored `meta.companions` key is ignored by old code. No migration.
- Deployment: see below.
- Result: **green**.

## Architecture impact

- **ADR required:** No (additive optional wire field, no migration; inside ADR-0004 and ADR-0020).
- **Relevant ADRs:** ADR-0004, ADR-0020.
- **Proposed ADR:** None

## Deployment

- **Deploy-affecting:** Yes (agent bundle and hub ship together).
- **Artifact invariant:** the built agent bundle (`apps/agent/dist`) contains the string `.modelctl.json`.
- **Functional probe:** after updating the NAS agent and requesting a catalog refresh, `GET /api/v1/models?q=Inkling-2-Mini` returns `companions.mmproj.path = "mmproj-F16.gguf"` and a `companions.draft.path` starting `dspark-`.
- **Rollback:** redeploy the previous tag; the stored `meta.companions` is inert.

## Validation evidence

- Configuration validation: `process-check` FAIL (4 problems), all pre-existing on `main` and outside this diff: provider-specific paths in `tasks/research-collapsed-rail-add-node-button.md:13`, `docs/research/IRI-009-research-brief.md:12,16,58`, `tasks/research-gguf-draft-companions.md:94`. Everything else passes.
- Tests: `IRORI_TEST_DATABASE_URL=postgres://…@localhost:54329/postgres pnpm -r test`: core 123, proxy 24, db 16, web 560, agent 342, server 482. All passed, 0 skipped (PG-gated suites ran).
- Typecheck: `pnpm -r typecheck`, 6× Done.
- Build: `pnpm build` green. Artifact invariant: `apps/agent/dist/irori-agent.mjs` contains `.modelctl.json`.
- Lint: `pnpm lint` reports 72 problems, the same as the `main` baseline (this diff adds none; the one it briefly added, an unused `HfDraftKind` import, is fixed).
- Documentation check: `docs-check` pass: API.md (frame field and `/api/v1/models`), SPEC §6 (drawer, chips, ⓘ, Runtime column), CHANGELOG (Added and Changed). ARCHITECTURE.md has no catalog-frame detail to update; no ADR needed.

## Review

- Correctness: the three wire states (absent = older agent, keep; `null` = none; `{unreadable}` = replace and show ⓘ) are pinned at every layer: agent, core schemas, PG merge, API lift, web helpers. A degraded mount is bounded three ways: 2 s per op, 8 in flight, and a 10 s budget per catalog. The inventory job skips companion reads (review F1).
- Security (security-check result): PASS, nothing CRITICAL and no WARNINGs. Store confinement via `realpath`; the metadata file is opened `O_NOFOLLOW|O_NONBLOCK`, must be a regular file, and is read under a 1 MiB cap. Paths and spec types are validated by the shared zod schema before they reach the wire; the jsonb merge is parameterized (verified rendered SQL); the web uses text/attribute bindings only. Remaining INFO: an intermediate-dir TOCTOU swap needs NAS write access and can only yield a validated relative path and a size. No full security audit (skill not installed).
- Data isolation and authorization: the model catalog is fleet-global; no new entry point. `GET /api/v1/models` is unchanged in access and gains one field.
- Compatibility and migrations: no migration. Every skew direction works: new agent → old hub strips the field; old agent → new hub preserves the stored value; new hub → old web strips; old hub → new web renders nothing. An unknown future `companions` shape degrades to unknown instead of dropping the catalog frame.
- Tests: agent 342, core 123, server 482 (PG), web 560, proxy 24, db 16, all green. New suites: `catalog-companions-iri155`, `catalog-companions-deadline-iri155`, `inventory-companions-iri155`, `models-companions-iri155`, `model-companions-iri155`; extended `catalog.test.ts` and `job-events.test.ts`.
- Documentation and ADRs: API.md, SPEC §6, CHANGELOG. No ADR (inside ADR-0004 and ADR-0020).
- Adversarial review (`quality-review`, fresh read-only context): **PASS WITH FINDINGS**, no BLOCK. F1 (inventory paid for companion reads under its 20 s deadline; about 80 hung entries blanked the store) fixed, with a regression test. F2 (a 1 MiB zeroed buffer per read) fixed. The forward-compat suggestion was adopted. **Delta re-review: PASS WITH FINDINGS**, no BLOCK. N1 (an fstat-sized buffer truncated a file whose CIFS size was stale) fixed by going back to a cap-sized `allocUnsafe` buffer. N2 (nothing pinned the inventory skip) fixed: `inventory-companions-iri155` fails when the fix is reverted (checked). N3 (the API schema rejected an unknown shape, failing the whole page) fixed with `.catch(undefined)`. Its wording note "10 s per catalog" was corrected to "per-model reads budget".
- Residual risks:
  - Thread pool: 8 concurrent reads exceed libuv's 4 threads, so on a hung mount, timed-out fs calls keep threads until the kernel returns. The per-catalog budget limits how many start; this is the same in kind as the pre-existing IR-206 bounds.
  - Overlapping catalog requests can finish out of order (pre-existing; companions widen the window slightly).
  - A store whose `models/` is itself a symlink to another volume would report every model unreadable (modelctl never creates one).
  - Pre-existing and out of scope: `scanStore` resolves modelctl's relative `active/` links against the store root instead of `active/` (scan fallback only).

## Completion summary

- **Technical decisions:** source of truth is the installed object's `.modelctl.json`, not the manifest. A separate `storeModelSchema` keeps modelctl's `catalog.json` parse independent. Owner decisions (2026-11-21): unreadable shows ⓘ "Cannot read the model's companion info from the NAS" in the drawer and the list row, replacing earlier values; a missing metadata file shows nothing. `draftKind` moved to `@irori/core` (server re-exports it). Focusable `.tip` elements now show their text on keyboard focus.
- **Known limitations:** rows appear only after a node's agent runs this bundle. Per-node `hf-cache` companions are out of scope.
- **Deployment notes:** the agent bundle and hub ship together; update the NAS agent (one-click agent update, ADR-0007), then refresh the catalog. Probe: `GET /api/v1/models?q=Inkling-2-Mini` returns `companions.mmproj.path = "mmproj-F16.gguf"` and a `dspark-` draft. Invariant: the agent bundle contains `.modelctl.json`.
- **Follow-ups:** fix `scanStore` relative-link resolution (separate ticket); live dev verification after the owner's deploy.
