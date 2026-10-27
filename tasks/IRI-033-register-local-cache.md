# Task: Register-from-cache — register-local job, orphan detection, and UI (IRI-033)

Jira: IR-104 (IR Sprint 2). Companion to modelctl v0.23.0, which shipped
`register-local` (verify an existing local HF cache entry against the active
NAS object by hash — blob-identity names and sizes for LFS blobs, content
hashes for small files — then write the registration without transferring
blobs). Context: IRI-028 research brief §3.6; on 2026-10-27 a manually moved
164G TensorFold-Ablit was registered on DGX-2 with 45.62 KiB read and zero
transfer.

## Objective

Manually moved or hf-cli-downloaded `models--*` cache dirs are invisible to
Irori: the Local cache card lists modelctl *registrations* only, and no
registration path exists short of a full re-sync. Surface the unregistered
entries ("orphans") in the inventory and offer a one-click, transfer-free
Register action backed by the new `register-local` job.

## Product manager summary

- **One-liner:** List unregistered HF cache entries per user and register them in place via `modelctl register-local`.
- **User value:** A moved or hand-downloaded model becomes managed (delete, placement, card) without re-copying hundreds of GiB.
- **Business impact:** Avoids redundant NAS traffic and the disk-doubling staging cost of `sync-local` for content that is already local.
- **Success metric:** TensorFold-Ablit on DGX-2 shows as a registered local model with no transfer; orphans appear for other caches.
- **Dependencies & constraints:** Requires modelctl >= 0.23 on the *cache user's* binary (the pin gate rises to 0.23.0); pre-0.23 binaries fail the job with modelctl's own "invalid choice" error.

## Acceptance criteria

- [x] `register-local` is a valid job kind end to end (core enum, agent argv, server allow/settle).
- [x] The agent builds `modelctl register-local NAME --source-root <nasRoot>` and wraps it `runuser` as the cache user when one is set (same shape as `delete-local`).
- [x] A succeeded `register-local` upserts the node-model row and drops the cached inventory.
- [x] The models inventory reports unregistered `models--*` dirs per user as derivable repo ids.
- [x] The node page lists orphans with a Register action whose confirm states that nothing is transferred and verification fails closed.
- [x] Agent default pin raised to 0.23.0 (code, CONFIGURATION.md, DEPLOYMENT.md, CHANGELOG).
- [x] Tests per layer green; `pnpm typecheck`, `pnpm test`, docs-check pass.

## Scope

### Included

- `packages/core`: job kind + `inventoryLocalCacheSchema.orphans` (defaulted `[]` so pre-0.23 agent reports and old cached rows parse).
- `apps/agent`: argv mapping, per-user orphan detection in `discoverLocalCaches`.
- `apps/server`: `INVENTORY_MUTATING_KINDS` + settle upsert branch.
- `apps/web`: orphan rows + Register confirm on the node page.
- Pin bump 0.22.0 → 0.23.0, SPEC/CHANGELOG/CONFIGURATION/DEPLOYMENT updates, ADR-0012.

### Excluded

- `deepseek-v4-flash-vision-exp` registration (owner choice; same one-click path now exists).
- Fleet rollout of modelctl 0.23 to other nodes' users (ops, after merge).
- modelctl-side changes (v0.23.0 already released).

## Plan

- [x] Confirm argv and semantics against modelctl 0.23 (`register-local --help`, live dry-run + register on DGX-2).
- [x] Core: kind + inventory field (backward-compatible default).
- [x] Agent: buildKindArgs case + orphan scan keyed off `list --local` repositories.
- [x] Server: settle effects.
- [x] Web: orphan rows + confirm + job card reuse.
- [x] Docs, ADR, tests, validation.

## Architecture impact

- **ADR required:** Yes — new agent job surface plus a data-contract change to the inventory report; the verify-then-register safety contract is durable. See `docs/adr/0012-register-local-without-transfer.md`.
- **Relevant ADRs:** 0004 (modelctl as supply-chain engine), 0011 (per-user cache ops).

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — exit 0
- Tests: `pnpm test` with a disposable Postgres (`IRORI_TEST_DATABASE_URL`) — all packages green (server 187 incl. `job-events.test.ts` "register-local upserts the node-model row and drops the cached inventory", agent 168 incl. the register-local argv matrix, web 241). One pre-existing load-flake in the agent env test reproduced once under parallel suites and passed in isolation (known pattern, 2026-10-19 note).
- Build: `pnpm build` — exit 0
- Documentation check: `.agentic/bin/docs-check` — exit 0, 17 changed files, no gaps
- Live smoke: built stack + disposable PG + real agent bundle with a fake `modelctl` recording argv — POST `register-local` job → agent spawned exactly `register-local glm-smoke --source-root /tmp/fake-store`, job succeeded, `node_models` row upserted, inventory cache dropped. Fleet agents need the new bundle before the hub can dispatch the kind (old agents fail with modelctl's own "invalid choice").

## Review

- Correctness: argv mirrors `delete-local` (raw runuser, scrubbed env, agent-side home/binary resolution — the hub never sends paths); orphans are compared case-insensitively and sorted; the job fails closed on any verification mismatch (modelctl-side).
- Security: new job kind reaches a privileged agent — it only ever runs `modelctl register-local <name>` with the node's store root; the name is a selector validated by modelctl, not a path. No credentials cross the wire.
- Compatibility: `orphans` defaults to `[]` so old cached inventory rows and pre-0.23 agent reports still parse; old agents ignore the new kind (their modelctl errors with an actionable "invalid choice").
- Residual risks: register-local on a node without `nasRoot` fails fast by design; re-running on an already-registered model is modelctl-idempotent.
