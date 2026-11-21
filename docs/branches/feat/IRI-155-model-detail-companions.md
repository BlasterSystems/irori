# feat/IRI-155-model-detail-companions

Ticket: [IR-269](https://blastersystems.atlassian.net/browse/IR-269) (IRI-155). Task file: `tasks/IRI-155-model-detail-companions.md`. Research: `tasks/research-model-detail-companions.md`.

## Business context

IR-264 made speculative drafts (MTP, DSpark, DFlash) and mmproj projectors selectable and downloadable, but once a model was on the NAS, Irori never said which companions came with it. Operators had to open a shell on the NAS and read `.modelctl.json` or run `modelctl serve-command`. This branch puts that information on the Models page.

## What changed

- **Detail drawer:** clicking a model shows a `projector` row (file, size) and a `draft` row (kind, file, size, and the `--spec-type` it serves with), for example `DSpark · dspark-Inkling-2-Mini-Q8_0.gguf · 0.4 GiB · --spec-type draft-dspark`.
- **List rows:** a `+draft` / `+mmproj` chip after the model name, with the file name on hover.
- **Unreadable info:** when the NAS info can't be read, the drawer and the list row show only an ⓘ labelled "Cannot read the model's companion info from the NAS". It is keyboard-focusable and has an accessible name.
- **Runtime column removed** from the Models list. Runtime is still in the filter chips and the drawer's header chip.
- **Under the hood:** the agent reads each installed model's `.modelctl.json` when it reports the catalog. The hub stores the result in the existing `model_meta.meta` (no migration), and `GET /api/v1/models` returns it as `companions`.

## Business rules and constraints

- **The installed object is the source of truth**, not the manifest: after a failed update, the manifest can describe companions that aren't installed.
- **Owner decisions (2026-11-21):**
  - models without companions show nothing;
  - an older download with no info file shows nothing;
  - any other read failure shows the ⓘ and replaces earlier companion info, so the page never shows companions it couldn't confirm on the last read.
- **Irori never writes to the store** (ADR-0004). Reads are confined to the store, never follow a symlinked info file, are capped at 1 MiB, and are bounded: 2 s per read, 8 in flight, and a 10 s budget per catalog.

## Edge cases handled

- **Older agents:** the field is absent, so the hub keeps what it stored and the page shows nothing until the agent is updated.
- **Version skew:** older hubs and web bundles ignore the field. A future, unrecognised shape is treated as unknown rather than dropping the catalog or blanking the page.
- **Hostile or corrupt store content:** links outside the store, symlinked or FIFO info files, oversized or corrupt JSON, unsafe paths, and invalid spec types all show the ⓘ. One bad model never drops the whole catalog.
- **Degraded mount:** the reads stop at the budget, and the node inventory job skips them entirely.

## Integration impact

- **Shipping:** the agent bundle and the hub ship together. The NAS agent must be updated (one-click agent update) for companions to appear.
- **Wire contract:** the `catalog` frame and `/api/v1/models` rows gain an optional `companions` field (documented in `docs/API.md`).
- **Code move:** `draftKind` moved from the server into `@irori/core`; the server re-exports it.

## Out of scope and follow-ups

- Companions of node-local `hf-cache` registrations.
- A pre-existing bug: the scan fallback resolves modelctl's relative `active/` links against the store root.
- Live verification on dev after the owner deploys.

## Verification

- `IRORI_TEST_DATABASE_URL=… pnpm -r test`: core 123, proxy 24, db 16, web 560, agent 342, server 482. All passed, 0 skipped.
- `pnpm -r typecheck` clean; `pnpm build` green; lint unchanged from `main` (72).
- security-check PASS. Independent adversarial review: PASS WITH FINDINGS, all findings fixed, and a delta re-review: PASS WITH FINDINGS, all fixed.

## Changelog

- 2026-11-21: Installed draft and mmproj companions on the Models page (drawer rows, list chips, ⓘ when unreadable); Runtime column removed.
