# Task: IRI-055 — capture proxy matches non-/v1 OpenAI paths

Jira **IR-154** (Bug, High, sprint 990). Independent of IR-153 (probe tokens).

## Objective

The capture proxy only captured `/v1/`-prefixed OpenAI paths
(`CAPTURED_ENDPOINT_RE`). TensorFold serves the bare and prefixed spellings
identically, so clients whose provider baseUrl omits `/v1` (the operator's
omp DGX1 provider) got silently uncaptured pass-through: serving worked,
`llm_requests` stayed empty, no error anywhere.

## Acceptance criteria

- [x] A POST `/chat/completions` (no `/v1`) through a capture-enabled setup
      produces a captured row identical to its `/v1` twin, endpoint
      canonicalized to `/v1/chat/completions`.
- [x] Probes/metrics/health and non-matching nested paths stay uncaptured.
- [x] The hub's `insertBatch` no longer acks malformed events without trace:
      rate-limited warning naming identity fields + first schema issue.
- [x] Docs state that capture matches regardless of `/v1` and baseUrls may
      include or omit it.

## Scope

### Included

- `packages/core/src/usage.ts`: `CAPTURED_ENDPOINT_RE` accepts an optional
  `v1/` prefix; new `normalizeUsageEndpoint()` canonicalizes captured paths
  to the `/v1/` spelling.
- `packages/proxy/src/proxy.ts`: stored endpoint via
  `normalizeUsageEndpoint` (single identity in read models; also keeps the
  agent OTEL `OPERATION_BY_ENDPOINT` regexes correct).
- `apps/server/src/usage-store.ts`: `insertBatch` malformed-drop path warns
  through an injectable sink (default hub logger), rate-limited to one line
  per 60 s per store with a carried count. Wire framing unchanged.
- Docs: CONFIGURATION.md capture-matching section; SPEC.md §11 wording.

### Excluded

- Anthropic `/v1/messages` capture (separate ticket if an Anthropic client
  appears); probe token counters (IR-153).

## Plan

1. Regex + canonicalizer in core with unit tests (bare/prefixed true,
   `/api/chat/completions`, `/v2/...`, trailing-segment false).
2. Proxy stores the canonical endpoint; e2e proxy test posts the bare path
   through the mock engine (which now serves both spellings, like TensorFold).
3. Hub drop-path warning with injectable warn/now; db-gated test asserts
   first-drop warn, window suppression, backlog count after the window.
4. Validate: core/proxy/server suites, build, typecheck, validate, docs-check.

## Architecture impact

- **ADR required:** No — widens the existing ADR-0008 §2 matching to cover
  the engine's documented dual spelling; storage/read models untouched.
- **Relevant ADRs:** ADR-0008 (context).

## Validation evidence

- Tests: core 100, proxy 24, server usage suites green (see run below);
  full workspace suite green.
- Build/typecheck/validate/docs-check: see PR.
- Live: operator's omp traffic must populate Usage/Chats after the dev tag
  (baseUrl needs no change).

## Review

- Correctness: canonicalization is a no-op for already-prefixed paths; the
  proxy forwards the ORIGINAL path untouched (only the stored endpoint is
  canonical). The warning sink never throws into the frame chain.
- Security: no new surfaces; malformed payloads are still never stored.
- Compatibility: older agents keep the old regex behavior until updated —
  same as every agent-side change (fleet coupling note on closeout).
- Residual risks: a client sending a bare path AND expecting to distinguish
  it from `/v1` in the UI cannot (canonical identity is intended).
