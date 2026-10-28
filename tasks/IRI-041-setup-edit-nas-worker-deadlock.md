# Task: Setup edit deadlock — sanitize legacy NAS/duplicate worker rows (IR-119)

## Objective

Editing the fleet's cluster setup fails with `NAS is a NAS node and cannot be a
worker` on Save — and equally on Stage transfers, save-without-starting and
Duplicate. The only setup row (`glm-5.3-flash-exl3-q4`, created 2026-10-24)
predates the IR-78 server-side setup-nodes validation (`4c9f1a2`, 2026-10-25)
and carries 6 worker rows: DGX-2 ×1, DGX-3 ×3, NAS ×2. The wizard loads stored
worker rows verbatim (`ServeView.vue:298`), the TYPE checkbox list filters NAS
out (`ServeView.vue:744`) so the invalid rows are invisible and unremovable,
and Save PATCHes them verbatim into `validateWorkers`
(`apps/server/src/setups-service.ts:323`) → 400.

Research: `docs/research/IRI-041-research-brief.md` (decision-complete; live
API probes of the corrupt row + node registry, chronology, fix options).

## Product manager summary

- **One-liner:** Sanitize the setup wizard's worker list so an edit of a
  pre-validation setup row loads, displays and persists only valid workers.
- **User value:** The owner can rename/retarget the fleet's cluster setup
  (currently impossible without delete + recreate or DB surgery).
- **Business impact:** Unblocks serving-config maintenance on the live fleet.
- **Success metric:** Edit → Save on the corrupt row returns 200 and the
  stored row's `nodes` is repaired (spark-only, deduped).
- **Dependencies & constraints:** None open; server validation stays strict.

## Acceptance criteria

- [ ] Pure `sanitizeWorkerIds` helper mirrors the server contract: dedupe
      (keep first occurrence, preserve order), drop head-self, drop
      NAS-kind, drop unknown ids.
- [ ] Edit and Duplicate load a sanitized worker list (review shows
      `head + 2 worker(s)` for the corrupt row, not 6).
- [ ] Every persistence path (Save, Save-without-starting, Stage transfers)
      sends sanitized `nodes` — the first successful Save repairs the row.
- [ ] Empty node inventory (registry not yet loaded) skips sanitization
      rather than wiping workers — the server backstops with a clear error.
- [ ] No server/agent changes; build + tests + validate green.

## Scope

### Included

- `apps/web/src/serve.ts`: pure `sanitizeWorkerIds` helper + unit tests.
- `apps/web/src/components/ServeView.vue`: apply sanitize at edit/duplicate
  load and in the `wizardInput()` payload builder.

### Excluded

- Server changes (validation stays as-is); one-time DB migration; TYPE-step
  UI changes; the `< 7` worker cap.

## Plan

- [x] Research: `docs/research/IRI-041-research-brief.md`
- [x] Implement helper + wiring
- [x] Add tests
- [x] Validate (pnpm test/build, .agentic/bin/validate, docs-check)
- [x] Fixture-browser verification (corrupt-row edit flow)
- [ ] PR + evidence comment

## Architecture impact

- **ADR required:** No — web-local repair over existing endpoints; no data,
  deployment, or integration boundary changes (the payload shape is
  unchanged; only invalid rows are dropped).
- **Relevant ADRs:** ADR 0009 (NAS store placement) — unaffected; staging
  picks the store node from the whole inventory
  (`setups-service.ts:704-706`), never from setup worker rows.

## Validation evidence

- Tests: `pnpm --filter @irori/web test` — 25 files, 259/259 green (serve.test.ts 6 → 9 with the `sanitizeWorkerIds` cases: dedupe keep-first/order, head-self + NAS-kind + unknown drop, gpu-host kept).
- Build: `pnpm --filter @irori/web build` — vue-tsc clean; vite bundle 450.5 kB.
- Configuration validation: `.agentic/bin/validate` — exit 0.
- Documentation check: `.agentic/bin/docs-check --base origin/main --strict` — exit 0.
- Fixture browser verification (built dist + fetch router + verbatim live-hub fixture, Chromium, light theme):
  - Corrupt-row edit: TYPE step shows only `DGX-2 · spark` / `DGX-3 · spark` checkboxes (NAS unlisted), both checked; Review shows `cluster — head + 2 worker(s)` (previously 6) with no error banner; Save fires exactly one `PATCH /api/v1/setups/69916930-c6d5-4d4a-98e7-2d05ed7c74d8` whose `nodes` is `[DGX-2, DGX-3]` — spark-only, deduped, first-occurrence order; wizard closes; the card re-renders without the `NAS · WORKER` lines; zero console errors.
  - Placement step lists DGX-1/DGX-2/DGX-3 only — the NAS row that the corrupt workerIds previously surfaced is gone (mock still returns a NAS placement; the client filter drops it).
  - Duplicate: worker picks are DGX-2/DGX-3 only (same `openWizard` sanitize).
  - Screenshot of the repaired Review step captured (light theme).

## Review

- Correctness: the helper mirrors `setups-service validateWorkers` (duplicate, head-self, unknown, NAS-kind) as one filter; the empty-inventory guard passes workerIds through untouched when the registry hasn't loaded, so the server produces its precise error instead of a silent wipe.
- Security: no new surfaces; client-side payload shaping only — server validation unchanged and still the backstop for non-wizard clients.
- Compatibility: `SetupCreateInput.nodes` shape unchanged; rows created before IR-78 become editable and self-heal on first successful save.
- Residual risks: a transiently stale inventory can miss a just-deleted node → the server rejects with `unknown worker node` until the next 2.5 s poll refreshes the list; no deadlock (the row is left untouched).
