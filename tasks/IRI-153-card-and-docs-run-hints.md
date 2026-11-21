# Task: Irori — run hints from the repo README and allow-listed linked docs (IR-267 / IRI-153)

## Objective

`GET /api/v1/hf-quants` reports which draft, projector and `--spec-type` the
repo's own run instructions use. It reads the README first, then a few
allow-listed linked docs pages. This lets the download modal (IR-268)
preselect the right companions, for example Inkling-2-Mini, whose command only
appears on unsloth.ai/docs. Epic IR-264; ADR-0020.

## Acceptance criteria

- [x] Inkling → `hints.draft = dspark-Inkling-2-Mini-Q8_0.gguf`,
      `specType = draft-dspark`, `source = docs`,
      `url = https://unsloth.ai/docs/models/inkling-2-mini`. Verified live,
      2026-11-21.
- [x] Unit tests cover:
  - the parser on the real GitBook markup, PowerShell and dflash snippets;
  - allowlist rejection (http, port, userinfo, IPs, look-alike hosts);
  - a redirect to an off-list host (169.254.169.254) and an allowlisted
    redirect;
  - the 2 MiB body cap and the content-type refusal;
  - no auth header to doc hosts, and the README token only on the HF origin;
  - hints for non-existent files dropped; foreign-repo paths rejected;
  - caching per (repo, revision), and the service never throwing.
- [x] ADR-0020 is Accepted and ARCHITECTURE/API/SPEC are updated. A
      `docs/SECURITY_AUDIT.md` entry isn't applicable: that file is the audit
      procedure, not a register, and ADR-0020 holds the boundary record.
      `security-check` is clean (see Review).

## Implementation

- New `apps/server/src/hf-card-hints.ts`:
  - `parseRunHints`, `resolveHint`, `pickHints`, `docLinks`,
    `isAllowedDocUrl`;
  - `guardedGet`: manual redirects, per-hop allow check, credentials only via
    `headersFor`, 5s timeout, 2 MiB streamed cap;
  - `createCardHintsService`, with a 10-minute, 100-entry cache.
- `packages/core/src/hf-quants.ts`: `hfRunHintsSchema` and `hints` on the
  result (nullish). The model-info `sha` is read so the README matches the
  listed commit.
- `apps/server/src/hf-quants.ts`: hints are attached only when a hints service
  is injected and the repo has GGUF quants. `index.ts` wires the production
  service.

## Decisions

- **Resolve is the safety gate.** The parser is regex-based and lenient,
  because GitBook markup is messy. Every value must map to exactly one file
  in the repo's own listing, so a lenient parser can't add a file.
- **Foreign-repo rejection.** Found during the live check: docs pages cover
  several models (`docs.unsloth.ai/models/gemma-4`). A snippet path containing
  a different `*-GGUF` directory is dropped rather than matched by basename.
- **Hints are opt-in in `createHfQuantsService`.** Existing callers and tests
  are unchanged, and only production wiring enables them.

## Validation evidence

- `pnpm --filter @irori/server exec vitest run test/hf-card-hints.test.ts
  test/hf-quants.test.ts`: 45 passed.
- Live (built server modules, real HF and unsloth.ai, 2026-11-21):
  - Inkling: hints from the docs page, as in the acceptance criteria.
  - unsloth gemma-4-26B: `mmproj-BF16.gguf` from `docs.unsloth.ai/models/gemma-4`,
    whose snippet names this exact repo.
  - bartowski and flint: no hints, no error.
  - About 0.6–1.0 s per uncached listing.
- Full `pnpm test`, `pnpm -r typecheck` and docs-check: see the commit.

## Review

- **Security check (author):** PASS, but it **missed** the regex DoS (it
  wrongly assessed the tag patterns as linear). Corrected after the
  independent review.
- **Independent review, round 1: BLOCK.**
  - F1 (blocker), regex DoS: `<[^>]+>`, the `<br…[^>]*>` pattern and the
    `[.,;:]+$` trim were quadratic on README text, freezing the event loop
    for about 54 s at 200 KB. Fixed:
    - `[^<>]*` tag patterns;
    - a bounded `LINK_RE` and a loop-based trim;
    - flag regexes compiled once;
    - a single linear pass over block ends (the regression test caught my
      own `indexOf` quadratic on the first fix);
    - 2 MiB regression tests: every payload ≤ about 100 ms.
  - F2, README overridden by docs: fixed with a field-by-field merge (README
    wins); docs are searched until a draft resolves.
  - F3, about 60 s worst-case listing: fixed with a shared 10s budget on top
    of the per-hop 5s.
  - F4, failures cached for 10 minutes: fixed; only successes are cached.
  - F5, invocations spilling into prose: fixed; they end at the closing
    `</pre>`/`</code>` or a ``` fence.
  - F6: fixed the same-repo prefix look-alike check; the docs URL is now the
    one reached after redirects; the README URL uses the configured HF origin.
- **Independent review, round 2: PASS WITH FINDINGS.** F1–F6 were verified
  fixed: 2 MiB adversarial payloads run in ≤ 215 ms, and round-1 payloads in
  1–19 ms, down from 35–54 s. The SSRF and token guards still hold. The
  follow-ups were applied:
  - R1: partial results now carry doc errors, so they aren't cached.
  - R2: API.md documents the ~20 s end-to-end bound (10 s listing + 10 s
    hints).
  - R3: `llama-mtmd-cli` is recognised (the gemma-3 docs use it).
  - R4: errors say whether the hints budget or a per-hop timeout fired.
- **Residual risk:** generic basenames like `mmproj-F16.gguf` on multi-model
  docs pages with bare snippet paths can still match through the basename
  fallback. The mmproj hint is informational in the UI (IR-268), and a draft
  hint must be one of the repo's own draft candidates.
