# Task: Surface agent bundle generation so stale bundles are visible (IR-260 / IRI-146)

## Objective

`agentVersion` (semver) does not reflect the agent bundle generation: a node
can run a pre-fix generation while reporting the current semver. This masked
the IR-251 install catch-22 on dgx3 (2026-11-15 08:43 update "confirmed 0.7.0"
while the running process still threw the pre-fix error). The agent hello now
reports the sha256 of its own bundle file; the hub diffs it against the
artifact it serves; the node page renders the verdict.

## Product manager summary

- **One-liner:** every node page shows whether the running agent bundle is the generation the hub serves.
- **User value:** a stale bundle is identifiable from the UI without ssh (previously a manual sha256 diff per the fleet-convergence runbook).
- **Business impact:** kills the semver-≠-generation trap that cost the dgx3 incident.
- **Success metric:** every node's page shows bundle state; a stale bundle reads "behind (running ab12…, expected cd34…)".
- **Dependencies & constraints:** none. Research: `tasks/research-dgx3-modelctl-clockcap-layout.md` (D3, owner-approved 2026-11-16).

## Acceptance criteria

- [ ] Every node's page shows the bundle generation state (identity meta line, all three states).
- [ ] A stale bundle is identifiable from the UI without ssh ("behind" carries truncated running/expected prefixes).
- [ ] Agents without the new hello field (and dev runs from sources) render "unknown" without errors — additive field, old-agent fallback; unknown is never "behind"/"current" (IR-243 rule).
- [ ] Tests: core schema + classifier, agent hello presence/absence, hub ingest (records/clears), store triple-state persistence + migration, route classification against a fixture artifact, web meta-line mount tests.

## Scope

### Included

- `packages/core` — optional `bundleSha256` on the hello schema; `bundle` state object + `bundleState()` classifier on `nodeInfoSchema`.
- `apps/agent` — `bundle.ts` (`selfBundleSha256Sync`, argv[1] `.mjs` only), transport option + hello spread, main.ts wiring.
- `apps/server` — hello persists the hash (`markSeen` triple-state: undefined untouched / null clear / string set); expected hash = mtime-cached sha256 of `deps.agentArtifacts.bundle`; `toNodeDto` emits `bundle` on every node payload.
- `packages/db` — nullable `nodes.bundle_sha256` + hand-written migration `0028_bundle_sha256.sql` (0018 precedent) + journal entry; IR-188 hash-membership migrator applies it on boot.
- `apps/web` — `bundleLabel` on the NodeDetail identity meta line (IR-252).

### Excluded

- Changing the semver scheme; automatic updates (agent-update stays manual and 409-guarded while setups run — per ticket).
- SSE push of bundle changes (the payload refreshes with node data; no live frame).

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** Yes — data-model + wire-contract change; recorded as [ADR-0019](../docs/adr/0019-self-reported-agent-bundle-generation.md) (Accepted 2026-11-16 — the owner decision from the round-15 research gate). Additive patterns per ADR-0017/IR-131; unknown-never-a-verdict per IR-243.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed
- Tests: `IRORI_TEST_DATABASE_URL=…54329 pnpm -r test` — 1430 passed, 0 failed (core 113, db 16, web 528, agent 320, server 429, proxy 24). `pnpm -r typecheck` — 6× Done.
- Build: `pnpm -r build` — green
- Documentation check: `.agentic/bin/docs-check` — exit 0 with the heuristic architecture warning (no ADR per above); CHANGELOG Unreleased Added entry.

## Review

- Correctness: expected-hash cache keys on path+mtime (a replaced artifact re-hashes on the next payload); the hub clears a stored hash when a hello arrives without the field, so a downgraded agent cannot pose as its predecessor's generation.
- Security: no new surface — the hash is non-sensitive and the hello is already authenticated.
- Compatibility: old agents → no field → "unknown"; non-strict zod strips the field both ways; five web fixtures gained the schema-default `bundle` literal (type-level only).
- Residual risks: the self-hash reads argv[1] at hello time — a bundle replaced between `mv` and restart would briefly report the new hash before the restart lands (the window is the update flow itself).
