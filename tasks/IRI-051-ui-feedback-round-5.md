# Task: IRI-051 — UI feedback round 5: serve wizard clarity + models placement/job panel

Jira epic **IR-141**, stories **IR-142** (S1 port prefill), **IR-143** (S2 picker order/density), **IR-144** (S3 recipe folder), **IR-145** (S4 review regroup), **IR-146** (S5 models placement + job sheet) — all in sprint 990. Research brief (expert-reviewed): `docs/research/IRI-051-ui-feedback-round-5-research-brief.md`.

## Objective

Fix four owner-reported UX problems from screenshots: (1) placement drawer + job sheet pairing is confusing (no target context, raw rsync dump, state/action double-speak), (2) the REVIEW step is noisy and omits placement node names and env values, (3) the model picker's order/scanability and the port resetting to 8080 on edit, (4) the scripts step should ask for a recipe folder plus start/stop names.

## Acceptance criteria

Per story — see the Jira tickets; summary:

- [ ] S1/IR-142: edit + duplicate prefill the setup's port; create defaults 8080; no staleness across wizard sessions.
- [ ] S2/IR-143: picker shows the full catalog name-ordered (numeric, case-insensitive, family-adjacent) via loop-fetch + client sort; Models page sort choice persists.
- [ ] S3/IR-144: recipe folder + start/stop names compose the stored paths (path-shaped names verbatim; differing dirnames fall back to full paths); required-check on composed values; env exports compacted.
- [ ] S4/IR-145: review groups Runs / Port and health / Scripts / Environment; placement node names; env values; no log row.
- [ ] S5/IR-146: job sheet target context + hub-parsed aggregate (`job.progress`) with collapsed raw; push stays raw-only; placement Node/State/Action with role subtext; live `syncing` chip from the SSE store with guards.

## Plan

1. S1: one line in `openWizard` (+ fixture check).
2. S2: loop-fetch + comparator helper in models.ts + localStorage persistence + picker template density.
3. S3: `splitRecipePaths`/`composeScriptPath` in serve.ts + tests; step-3 template; nextStep gate on composed values.
4. S4: review template regroup; placement names from `nodes`.
5. S5: sheet header/summary from `job.progress` (+ fallback parse); raw collapsed; placementChip copy + role subtext; live chip via `live.jobs` guard predicate.
6. Validate: `pnpm -r test`, `pnpm build`, `.agentic/bin/validate`, `.agentic/bin/docs-check`; fixture browser verification of all four surfaces.

## Decisions

- Aggregates come from `job.job.progress` (hub-parsed since IR-131, single-stream) — client parsing only as fallback; push stays raw-only (4 streams, hub emits no parsed progress). Expert-review amendment (was: parse last progress2 line).
- Live syncing chip driven by `live.jobs` SSE store, not the open sheet's poll — survives close, covers concurrent jobs.
- Models page default sort stays "Recently added"; the choice persists. The picker (the complained surface) is always name-ordered over the full catalog window.
- No API/contract changes; no new wizard steps; `joblog`/`rawlog`/`sheet__foot` classes kept for the chrome-markup pins.

## Validation evidence

- Tests: `pnpm -r test` fully green (core 99, server 224, web 291 incl. 12 new, db 5, agent 196, proxy 23) against disposable Postgres.
- Build: `pnpm build` green (all packages).
- Configuration validation: `.agentic/bin/validate` — "Configuration validation passed".
- Documentation check: `.agentic/bin/docs-check` — no gaps.
- Fixture UI verification (built surfaces via vite + fetch-router/EventSource mocks):
  - Edit prefill: the wizard opened with port **8081** (was 8080 before S1); duplicate path shares the prefill.
  - Picker: **2-column grid**, all 10 fixture models fetched across 3 pages and client-sorted (alpha-3b first, family-adjacent).
  - Scripts: edit prefilled folder `~/developer/recipes/GLM-X` + basenames; after editing to GLM-Y/start-v2.sh the validate POST carried the composed paths.
  - Review: Runs / Port and health / Scripts / Environment sections; head `dgx1` + worker `dgx2` chips; `EXTRA_ARGS=--host 127.0.0.1` value chip; no log row.
  - Models: thead `Node | State | ""` with role subtext; state copy `needs push` / `needs sync` / `present`; live `syncing 0%` chip from the SSE-seeded store (independent of the sheet); job sheet docked beside the drawer with context `on dgx2 · GLM-5.3-Flash-EXL3-4bpw`, hub-parsed summary `0.5 GiB of 163.6 GiB · 0% · 361 Mb/s · eta 1h 03m`, raw output collapsed. Screenshot captured.

## Review

- Correctness: compose/split round-trip is unit-tested; the step-3 gate checks composed values; aggregate progress comes from the hub-parsed `job.progress` (never one stream labeled aggregate — push stays raw); the syncing chip is guarded on kind/status/model/node.
- Security: web-only; no new routes; no secrets in play.
- Compatibility: no API or contract change; `joblog`/`rawlog`/`sheet__foot` chrome pins kept green.
- Residual risks: the models page default sort stays "Recently added" (choice persists); two Close buttons on the docked pair remain (visually distinct surfaces now); native-tooltip idiom avoided (DS subtext used).
