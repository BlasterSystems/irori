# Task: IRI-016 — GGUF multi-quantization + MTP downloads (modal)

Jira: [IR-70](https://blastersystems.atlassian.net/browse/IR-70) (sprint 985)
Decision: owner direction 2026-10-21 — support multi-quant GGUF repos and MTP artifacts
in the download modal "as modelctl supports them" (flint-GGUF, gemma-4-31B-it-GGUF
examples), plus the modal UI/spacing/CTA fixes from the same review.

## Objective

One HF repo containing many GGUF quantizations (and MTP/mmproj files) can be queued
from the download modal into the store exactly as modelctl models it: one entry per
quantization, optional per-entry `quantization` and `mtp`, companions auto-selected by
modelctl. Modal spacing/styling brought to DS conformance and the "Add 0 to queue" CTA
fixed.

## Acceptance criteria

- [x] Per-entry optional `quantization` and `mtp` flow end-to-end: modal row inputs →
      `downloadCreateSchema`/batch schema → `download_queue` (migration 0015) →
      `dispatchIfIdle` payload → agent YAML (no agent change) → modelctl queue preflight
      accepts the generated YAML.
- [x] "Expand quants" affordance: per-row expansion from a hub-side listing
      (`GET /api/v1/hf-quants?repo=`), TS port of modelctl's `_gguf_groups` (shard
      regex, mmproj/mtp exclusion incl. parent-dir `mtp`, `(dir, base, count)` key),
      pinned by fixture tests built from the real flint-GGUF and gemma-4-31B-it-GGUF
      file lists (brief §3). Sizes shown when > 0 (`?blobs=true`).
- [x] Expansion derives rows named `{repo-tail}-{TAG}` with `quantization: TAG`
      (disambiguated per brief §6), dedupes on `(source, quantization)`, respects the
      50-entry batch cap, and offers MTP candidates (root default, folder variants
      explicit) as a per-row choice when present.
- [x] Manual path still works without expansion: typed `quantization`/`mtp` strings are
      passed through untouched (modelctl substring semantics).
- [x] Modal UI fixes (brief §7): `.hytable` → `.table` (4 usages), field-group spacing
      via `--space-*` tokens (no inline margin hacks), "Parse rows" not stretched,
      CTA label `Add to queue` at 0 rows / `Add N to queue` when N > 0, Parallel jobs
      input narrowed.
- [x] Tests: core schema passthrough, server enqueue/dispatch + migration, grouping
      fixtures, web chrome pins updated.
- [x] Docs: SPEC §6 (modal + queue fields), `docs/API.md` (new endpoint + entry fields),
      ADR scan (none expected — no boundary change).
- [x] Validation: `pnpm -r test`, `pnpm build`, `.agentic/bin/validate`,
      `.agentic/bin/docs-check`; live smoke: full modelctl run of the Irori-built YAML
      (scratch root, tiny GGUF) — preflight validated `quantization: IQ3_XS` remotely,
      downloaded only the selected quant + card, published, activated (research-phase
      preflight-cancel against flint-GGUF replaced by this complete run).

## Scope

### Included

- Core schema + DTO, db migration 0015 (`download_queue.quantization`, `.mtp`), server
  enqueue/batch/dispatch/retry passthrough, hf-quants listing endpoint, modal UX +
  fixes, docs, tests.

### Excluded

- modelctl changes (none needed — verified §1–2 of the brief).
- Serving GGUF/llama-server provisioning (open question 1 in the brief).
- Per-row revision/runtime/mmproj fields (mmproj is auto-selected by modelctl; runtime
  auto-infers).
- Downloading an MTP draft as its own entry (possible later via a plain row; the
  `dflash-`/`mtp-`-as-entry cases stay manual).

## Plan

- [x] Research brief: [docs/research/IRI-016-research-brief.md](../docs/research/IRI-016-research-brief.md)
      (modelctl grouping/selection/companions, HF repo layouts, live store evidence,
      pipeline audit, options A/B/C, modal UI review F1–F7).
- [x] Core: `downloads.ts` schema + DTO fields; name-derivation helper stays
      UI-side (`{tail}-{TAG}`).
- [x] DB: migration 0015 + drizzle snapshot (also fixed a phantom
      `client_identities_key_idx` in the 0014 snapshot that made drizzle emit an
      invalid DROP).
- [x] Server: passthrough in `download-queue-service.ts` (enqueue, enqueueBatch,
      dispatchIfIdle, retry), hf-quants endpoint + grouping port + fixtures.
- [x] Web: modal rows (quantization/mtp inputs, expand flow), UI fixes F1–F5.
- [x] Docs + tests + validation runs + live modelctl run of the agent-shaped YAML.

## Architecture impact

- **ADR required:** No — no store-mutation or transport boundary change; ADR-0004
  (modelctl-only writes) and ADR-0009 (server-side queue) hold.
- **Relevant ADRs:** 0004, 0009.
- **Proposed ADR:** None.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` ✓; `.agentic/bin/docs-check` ✓
  (empty diff).
- Tests: `pnpm -r test` green — core 67 (new: quantization/mtp trim+passthrough,
  quant-suffixed name derivation, pre-0016 DTO parse), db 4, agent 22 (mtp YAML pin),
  web 185 (updated chrome pins incl. no-`hytable`, "Add to queue" at 0 rows),
  server 138 + **160/160 with `IRORI_TEST_DATABASE_URL`** (disposable PG; new
  dispatch-passthrough test asserts the agent payload carries
  quantization/mtp and derived names survive retry; new hf-quants suite: real-layout
  fixtures, needle disambiguation, incomplete-shard throw, HF error mapping).
  `pnpm -r typecheck` ✓, `pnpm build` ✓.
- Build: `pnpm build` ✓ (all packages).
- Documentation check: `.agentic/bin/docs-check` ✓.
- Live smoke (built stack, disposable PG, real HF):
  1. `GET /api/v1/hf-quants?repo=unsloth/flint-GGUF` → 10 groups with unique needles
     (BF16 sharded ×3), companions empty — matches the HF page.
  2. `POST /api/v1/downloads` single `{source, quantization}` → row
     `flint-GGUF-UD-IQ1_M` pending; batch of two same-repo rows →
     `gemma-4-31B-it-GGUF-UD-Q4_K_XL` (+`mtp: MTP/mtp-…-Q8_0.gguf`) and
     `gemma-4-31B-it-GGUF-Q8_0` — no name collision.
  3. Browser (dark + light): parse → 4-column rows table (DS `.table`), Expand panel
     lists 10 quants with GiB sizes and shard counts, "Add 2 rows" replaced the row
     with `flint-GGUF-BF16`/`flint-GGUF-Q8_0`, field gaps 12px, Parse rows 81px,
     Parallel jobs 120px, CTA "Add 3 to queue" / "Add to queue" (disabled) at 0 rows.
  4. modelctl end-to-end: the agent-shaped queue YAML
     (`{source, name: smol-gguf-IQ3_XS, quantization: IQ3_XS}`) ran to completion
     against a scratch root — preflight validated the quantization remotely, fetched
     only the 84 MiB quant + README, published and activated as a llama.cpp entry.
     Scratch store removed after the run.

## Review

- Correctness: grouping port pinned to real repo layouts; needle derivation requires
  own-basename match AND uniqueness (ambiguous rows disabled); dispatch payload omits
  null fields (older agents still parse); settle stays name-keyed and modelctl
  preflight rejects duplicate names, so the derived `{tail}-{TAG}` default is what
  keeps same-repo batches unambiguous.
- Security: hf-quants is a read-only proxy of the public HF API with a repo-id
  allowlist regex (`..` rejected, no auth sent, 10s timeout); the modal keeps sending
  form-built JSON (raw YAML still rejected agent-side); no new agent surface — the
  builder already whitelisted quantization/mtp.
- Compatibility: pre-0016 API rows and old hub responses parse (DTO fields nullish);
  older modelctl pins that ignore nothing new (queue YAML fields were already legal);
  the 0015 migration adds nullable columns only.
- Residual risks: (1) the hub needs outbound internet for hf-quants — without it the
  expand flow errors with a banner and manual quantization entry remains; (2) repos
  with several mmproj files and no f16 default cannot be queued from the modal
  (modelctl would refuse) — surfaced as an inline warning, CLI/manual manifest
  required; (3) UI cap-trimming is UX-only — the zod 50 cap is the hard guarantee.
