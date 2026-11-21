# Research — show a model's draft and mmproj companions in the Models detail drawer

Status: ticket created, **IRI-155 / [IR-269](https://blastersystems.atlassian.net/browse/IR-269)** (Story, linked "relates to" IR-264), ready for `implement`. Date: 2026-11-21. Follow-up to epic IR-264 (IRI-150, ADR-0020).

## Tracker target

- **Jira project `IR`** (blastersystems.atlassian.net), reached through the project MCP server
  `mcp-atlassian`. Resolved from the project files: local `IRI-<n>` ids map to `IR-<n>`
  (`docs/DEVELOPMENT_PROCESS.md:105`, `tasks/IRI-148-…md:1`).
- **Overlap search (2026-11-21):** no open `IR` tickets match companion, mmproj, draft, "model
  detail" or "model drawer". The closest is IR-264 (Done), which made drafts downloadable but
  never displays them.

## Summary

The owner asked: when a model in the Models list has an associated draft and/or mmproj file,
they should appear in the model details when the user clicks that list item. Owner decisions
at the gate (2026-11-21):
- also show a small companion chip on list rows;
- show nothing in the drawer for models without companions;
- **remove the Runtime column** from the Models list. Today the hub
never learns about companions. The only ways to see them are a shell on the NAS
(`.modelctl.json`, `modelctl serve-command`) or inferring them from sizes. Proposal: the
agent reads each active model's published object metadata (`.modelctl.json`) when it reports
the store catalog. The companions then travel as an additive optional field into the existing
`model_meta.meta` jsonb column (no migration), out through `/api/v1/models`, and the detail
drawer renders them. **This fits in one ticket.**

## Current state (evidence)

- **What the drawer shows.** Clicking a list item runs `openModel(name)`
  (`apps/web/src/components/ModelsView.vue:1039-1061`), which fetches placement only. The
  drawer (`ModelsView.vue:1456-1470`) shows `repo`, `size` and `added`, plus the placement
  table. Repo, runtime and added come from the `/api/v1/models` row (`catalogEntry`,
  `ModelsView.vue:922-934`).
- **What the API carries.** `modelEntrySchema` = name, runtime, repository, bytes,
  firstSeenAt, updatedAt (`packages/core/src/model-api.ts:6-14`). `GET /api/v1/models` spreads
  the `model_meta` rows (`apps/server/src/app.ts:1881-1896`).
- **Hub storage.** `model_meta.meta` is a jsonb column documented as "HF revision,
  quantization, companions, card summary — agent-supplied JSON"
  (`packages/db/src/schema.ts:229-235`). In practice `onCatalog` only writes `meta: {source}`
  on insert and doesn't update `meta` on conflict (`apps/server/src/jobs-service.ts:664-683`).
- **Wire.** The agent→hub `catalog` frame carries `entries: catalogModelSchema[]`, which is
  name/runtime/repository/bytes only (`packages/core/src/job-messages.ts:42-46`,
  `packages/core/src/catalog.ts:4-9`). The hub hands them to `onCatalog`
  (`apps/server/src/hub.ts:78`, `:452`).
- **Agent read.** `onCatalogRequest` → `readStore(nasRoot)` (`apps/agent/src/main.ts:472-487`).
  It reads `catalog.json` (schema 3), or else scans `active/` and parses the
  `manifests/<name>.yaml` fields name/repo/revision/format/runtime only
  (`apps/agent/src/catalog-read.ts:42-71`, `:111-178`). Every fs op is async and bounded at 2 s
  (`catalog-read.ts:18-40`, IR-206).
- **Where companions live.** modelctl's `catalog.json` has no companion data
  (`modelctl/src/modelctl/catalog.py`, no `companions`/`files` keys). The published object's
  `.modelctl.json` has `companions` ({mmproj, mtp}), `entrypoint`, `files: [{path, size,
  sha256}]` and an optional `draft_spec_type` (`modelctl/src/modelctl/validation.py:183-205`).
  It's reachable at `<root>/active/<name>/.modelctl.json`, because `active/<name>` is a symlink
  to the object dir. The manifest YAML also lists companions, but it describes the requested
  selection, not the published one: a failed update leaves a new manifest next to the old
  active object (`generation.py` `download_generated_manifest`, write-then-update).
- **Spec-type display.** The web already mirrors modelctl's default
  (`apps/web/src/draft-choice.ts` `defaultDraftSpecType`, `effectiveDraftSpecType`,
  `draftKindLabel`), parity-tested against `modelctl.drafts.default_spec_type`.
- **Live example (dev, 2026-11-21):** `Inkling-2-Mini-GGUF-Q4_K_XL` has companions
  `mmproj-F16.gguf` and `dspark-Inkling-2-Mini-Q8_0.gguf` (object `…--c8d27935d3f2`), but
  `/api/v1/models` returns only `{name, repository, runtime, bytes, meta: {source:
  "catalog"}}`.
- **Frame size:** frames are capped at 64 MB (`hub.ts` `MAX_USAGE_FRAME_BYTES`). Companions
  add about 200 B per model (79 models on dev today).

## Gap analysis

1. The agent never reads companion data.
2. The catalog frame and `ModelEntry` have no place to carry it.
3. `onCatalog` never refreshes `meta`, so even an agent that sent data couldn't update an
   existing row.
4. The drawer has nothing to render.

## Proposed design

- **Source of truth:** the published object's `.modelctl.json`, read through
  `active/<name>`. It reflects what is actually installed and served. Not the manifest, which
  can be ahead after a failed update.
- **Agent (`catalog-read.ts`):** a new bounded `readCompanions(root, name)`:
  - `lstat` and `readlink` stay inside the store;
  - read `.modelctl.json` with the existing 2 s bound and a 1 MiB size cap, then `JSON.parse`;
  - pick `companions.mmproj` / `companions.mtp`, take each one's `size` from `files[]`, and
    `draft_spec_type` if present;
  - validate every path as relative with no `..`, ignore anything malformed, and never fail
    the catalog.

  `readStore` enriches entries in both the catalog and scan paths, with limited concurrency
  (e.g. 8), so a slow CIFS mount stays bounded.
- **Wire (`packages/core`):** add optional
  `companions: { mmproj: {path, bytes|null} | null, draft: {path, bytes|null, specType:
  string|null} | null } | null` to `catalogModelSchema`, and so to `ScannedModel` and the
  catalog frame. Leaving it out means "unknown" (old agents); `null` means "known, none".
- **Hub (`jobs-service.ts onCatalog`):** write `meta.companions` on insert, and on conflict
  merge it into `meta`, but only when the frame carried the field. Old agents never wipe
  data. No migration: the jsonb column already exists.
- **API:** `modelEntrySchema` gains an optional `companions` (same shape). `/api/v1/models`
  lifts it out of `meta`.
- **Web drawer (`ModelsView.vue`):** under repo/size/added, two `kv` rows when present:
  - `projector` → `mmproj-F16.gguf · 0.6 GiB`;
  - `draft` → `DSpark · dspark-Inkling-2-Mini-Q8_0.gguf · 0.4 GiB · --spec-type draft-dspark`.

  The kind comes from the filename (`draftKind` parity), and the spec type is the recorded
  value or else `defaultDraftSpecType`. When companion data is unknown (older agent) the rows
  are simply absent; there's no "none" claim. When it's known-none, nothing is shown either
  (owner decision).
- **Web list (`ModelsView.vue:1350`, `:1368`):**
  - **Remove the Runtime column**: the `<th>` and the per-row `<td>`. Runtime stays visible
    through the runtime filter chips (`:1305`) and the drawer header chip (`:1460`), and the
    filter logic (`:128-166`) is unchanged.
  - Add a small chip after the model name, inside the Model cell (DS `.chip`): `+draft`
    and/or `+mmproj`, shown only when companions are known and present. The title text names
    the files.
  - Fix the expanded-row `colspan` (`:1658`, currently 5) to match the new column count.
- **Docs:** `docs/API.md` (models row and catalog frame), SPEC §6 (drawer), CHANGELOG.
- **ADR:** not required. It's an additive, optional wire field with no schema migration
  (unlike 0028/0029), inside ADR-0004's read-only store boundary and consistent with
  ADR-0020's companion contract. Reference ADR-0020 from the task file. If
  `.agentic/bin/docs-check` flags it, record the decision in the task file.

**Rejected alternatives:**
- **Parse `manifests/<name>.yaml`.** It's the requested selection, not the installed one, and
  would show the wrong companions after a failed or forced update.
- **modelctl catalog.json schema 4 with companions.** It's cleaner long-term, but needs a
  modelctl release and pin, and still leaves old stores without the data.
- **On-demand hub job per drawer open** (a `modelctl serve-command` or metadata read). It's a
  job round-trip on every click, busy-node conflicts, and slow.
- **A new DB column.** The `meta` jsonb already exists for exactly this.

## Phased delivery plan

**One story** (no epic): **IRI-155 / IR-269**, Models: show draft and mmproj companions (detail drawer and list chip); remove the Runtime column.

Acceptance criteria:
- [ ] The agent catalog frame carries `companions` per store model, read from the active
  object's `.modelctl.json`. It's bounded (2 s per op, ≤ 1 MiB, limited concurrency),
  confined to the store, and malformed or missing metadata becomes `companions` null or
  absent, never a failed catalog.
- [ ] The hub merges `companions` into `model_meta.meta` on insert and update, and an old
  agent's frame (no field) leaves the stored value untouched.
- [ ] `/api/v1/models` rows expose `companions`, and older hubs and clients keep parsing.
- [ ] The drawer shows projector and draft rows (kind, file, size, effective `--spec-type`)
  for models that have them, and nothing for models without.
- [ ] List rows show a `+draft` / `+mmproj` chip, inside the Model cell, for models with
  companions, and nothing otherwise.
- [ ] The Runtime column is removed from the Models list (header and cells, colspan fixed).
  The runtime filter chips and the drawer runtime chip still work.
- [ ] Tests:
  - agent: an Inkling-like object, legacy without metadata, malformed JSON, a symlink escape,
    the size cap and the timeout;
  - core: schema back-compat;
  - server: insert/update/no-field-preserve against PG;
  - web: pure helper unit tests and markup pins.
- [ ] Live on dev: `Inkling-2-Mini-GGUF-Q4_K_XL`'s drawer shows `mmproj-F16.gguf` and
  `DSpark · dspark-Inkling-2-Mini-Q8_0.gguf · --spec-type draft-dspark`, and its list row
  shows the chips. A model without companions (e.g. a vLLM safetensors entry) shows neither.
- [ ] Docs: API.md, SPEC §6, CHANGELOG. Process: security check (new file read from the
  store) and the independent review.

Deploy-affecting: the agent bundle and hub ship together. Agents update through the existing
one-click agent update (ADR-0007); until a node's agent is updated its models show no
companion rows.

## Risks and open questions

1. **Agent rollout.** Companion rows appear only after the NAS agent runs the new bundle.
   Default: accept it; the drawer omits the rows when unknown.
2. ~~"No companions" line~~: resolved, show nothing (owner).
3. ~~List-row badge~~: resolved, a `+draft` / `+mmproj` chip in the Model cell (owner).
4. **Per-node local caches** (DGX `hf-cache` registrations also carry metadata). Default: out
   of scope. The Models list is the NAS store catalog.
5. **CIFS cost:** `catalog-request` goes to every online agent with a `nasRoot`, so the DGXs
   read over CIFS too. That means about 79 extra small reads per catalog request per node,
   which the bound and concurrency limit keep in check. Default: accept; revisit if the
   catalog read time grows.

## Overlap findings

- IR-264 / IRI-150 (Done): it made draft and mmproj companions selectable and downloadable,
  and recorded the contract (ADR-0020). It never surfaced them after download. This ticket
  closes that loop.
- No other open `IR` ticket covers it (Jira search, 2026-11-21).
