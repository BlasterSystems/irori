# IRI-038 — Push self-healing (preflight, destination deps, transfer keys)

- **Ticket:** epic IR-112, stories IR-113 (preflight), IR-114 (destination deps), IR-115 (key exchange) — sprint 990
- **Status:** in progress
- **Research:** `docs/research/IRI-038-research-brief.md` (decision-complete; local evidence)
- **ADR:** `docs/adr/0014-self-provisioned-push-dependencies.md` (Accepted 2026-10-27, owner scope decision; supersedes ADR-0011's owner-ops prerequisite note)

## Objective

A dgx→dgx push failed twice on 2026-10-27 (DGX-1 → DGX-3, 163.6 GiB): missing destination modelctl, then missing ssh trust — both surfacing as the same ambiguous modelctl error. The agent should provision or explain every push dependency: classified preflight, destination rsync/modelctl ensure, and hub-orchestrated transfer keys (private keys node-local).

## Product manager summary

- **One-liner:** Pushes between sparks self-provision ssh keys, host keys, rsync and modelctl, and fail fast with classified, actionable preflight output when they cannot.
- **User value:** First-click transfers; no owner SSH ceremony per node pair; real error messages.
- **Business impact:** Removes the fleet's remaining manual ops step for transfers.
- **Success metric:** A never-wired pair pushes successfully end to end; a broken pair fails in seconds with the exact remediation.
- **Dependencies & constraints:** ADR-0014; one-active-per-node sequencing; no hub-held credentials (ADR-0007).

## Acceptance criteria

- [ ] A push to a wired pair runs the transfer with no manual steps; a push to an unwired pair auto-wires first (key ensure → authorize → host-key pin → push).
- [ ] Preflight classifies `auth-failed` / `host-key` / `unreachable` / `modelctl missing` / `rsync missing` per host and fails in seconds with remediation lines in the job output.
- [ ] Destination rsync ensured by a root job; destination modelctl via ADR-0013 auto-dispatch.
- [ ] Private keys never leave the source node; the hub stores/relays public material only; keys tagged `irori-transfer`.

## Scope

### Included

- Agent: push preflight script, `ensure-rsync`, `transfer-key-ensure`, `transfer-key-authorize`, `transfer-hostkey-pin` job kinds.
- Server: push-stage orchestration (sequencing + `JobBusyError` backoff), `transfer_links` table + migration.
- Docs: ADR-0014, ADR index/0011 supersession note.

### Excluded

- modelctl upstream error-message fix (moot once preflight exists); UI beyond streamed job output; non-LAN transfer security.

## Plan

- [x] Understand requirements and inspect relevant code (research brief IRI-038)
- [x] Confirm architecture impact (ADR-0014)
- [x] Implement the smallest complete change (IR-113 → IR-114 → IR-115, sequentially)
- [x] Add or update tests (agent builders/scripts, server parsePushBlocked)
- [x] Update documentation (ADR index, ADR-0011 reference note)
- [x] Run validation

## Architecture impact

- **ADR required:** Yes — ADR-0014
- **Relevant ADRs:** ADR-0003, ADR-0007, ADR-0011 (prerequisites automated), ADR-0013

## Validation evidence

- `pnpm typecheck` (6 pkgs) + `pnpm build` green.
- `pnpm test`: agent 176 (new preflight/ensure-rsync/transfer-kind builder tests; the
  hfToken env test's `vi.waitFor` windows widened — it flaked 3x on 2026-10-27 under
  load, assertions unchanged), server 201 (new `parsePushBlocked` tests), core/web/proxy
  unchanged-green.
- `.agentic/bin/validate` + `.agentic/bin/docs-check` green (ADR graph rules satisfied —
  the ADR-0011 relationship is prose, not a structured supersession).
- Live preflight smoke: the generated push script (real `buildCommand` output, bundled)
  executed against `piresbruno@dgx3.as267.com` from a keyless host — classified
  `ssh auth failed`, emitted `IRORI_PUSH_BLOCKED=`, exited 1 before any transfer.
- Full wire + re-push flow: unit-covered (script content + marker parse); live run
  requires the deploy + agent updates on DGX-1/DGX-3 — covered in the deploy step.

## Deploy

- (pending — PR open, awaiting owner merge; next dev tag dev-0.3.0-48. Post-deploy:
  agent-update DGX-1 and DGX-3 so the new job kinds/preflight ship, then a real
  dgx1→dgx3 push exercises the preflight ok-path.)

## Review

- Correctness:
- Security:
- Compatibility:
- Residual risks:
