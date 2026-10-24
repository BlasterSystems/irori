# Task: modelctl pin bump 0.22.0 — download progress light-up (IRI-021)

Jira: IR-75 (modelctl: emit progress JSONL during downloads + irori pin bump).
Modelctl side done 2026-10-24 (v0.22.0, piresbruno/modelctl PR 8); this record
covers the irori side only.

## Objective

Make the shipped download-progress surfaces actually light up: the NAS store
node still runs modelctl 0.21.3 (tqdm bars only, no `progress:` JSONL on
stderr), so every row/strip/summary renders nothing. Bump the agent's
`IRORI_MODELCTL_PIN` default to 0.22.0, deploy, roll the NAS agent bundle, and
verify live per IR-75's acceptance criteria.

## Acceptance criteria

- [ ] Agent default pin is 0.22.0 (code + docs + changelog).
- [ ] dev tag deployed; NAS agent bundle re-rolled via `agent-update` (IDLE
      queue only, never mid-batch — the restart severs the job socket and the
      one-active guard 409s anyway).
- [ ] `modelctl-install` on the NAS reports "modelctl 0.22.0 satisfies the
      0.22.0 gate".
- [ ] A real download on the NAS: running queue row shows %, bytes, live
      speed; batch totals strip populates; job drawer summary lines carry
      live values and the collapsed raw log shows the `progress:` JSONL.
- [ ] UI validated against `mockups/models-downloads.html`.

## Scope

### Included

- `apps/agent/src/config.ts` default pin bump; docs; changelog; this record.
- Rollout + live acceptance (IR-75 scope: PR + dev tag + agent-update + install job).

### Excluded

- No irori server/API changes (hub parser shipped in IR-71/74).
- No modelctl changes (v0.22.0 released).
- Spark agents' env pins: IRI-006 bootstrapped dgx1 with
  `IRORI_MODELCTL_PIN=0.20.1` in its env file; env overrides the bundle
  default and `config-update` carries no pin. Sparks get no install jobs in
  normal operation, but check an agent's env before any `modelctl-install`
  there.

## Plan

- [x] In-depth review of the progress pipeline (see Validation evidence).
- [x] Confirm no ADR required (config default under ADR-0004 pinning).
- [x] Implement the smallest complete change (default bump + docs).
- [x] Tests (existing suite covers the install-job argv; no default-value test).
- [x] Update documentation (CONFIGURATION.md, DEPLOYMENT.md, CHANGELOG.md).
- [x] Run validation.

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** ADR-0004 (modelctl ownership/pinning), ADR-0007
  (hub-driven agent updates), ADR-0009 (server-side download queue).

## Validation evidence

- Review (2026-10-24, live fleet): job `c1c9ef75` (download-queue, NAS node
  63a12a25) output contains tqdm bars only — zero `progress:` lines; all
  `download_queue` rows have `bytes_done/speed_bps NULL`. Hub dev-0.3.0-24 has
  the full chain wired: `hub.ts:325` job-output → `index.ts:229-232` →
  `download-queue-service.ts:388 onJobOutput` (parse, name/entry/single-row
  match, guarded UPDATE). Agent `modelctl.ts:253-255` captures stderr. Web
  `ModelsView.vue` renders dlbar rows + batch strip + drawer summary + rawlog
  (2 s queue/drawer polls). Installer writes no `IRORI_MODELCTL_PIN` to
  `/etc/irori/agent.env`, so the bundle default governs the NAS.
- Configuration validation: `.agentic/bin/validate`
- Tests: `pnpm test`
- Build: `pnpm build`
- Documentation check: `.agentic/bin/docs-check`
- Live: see IR-75 closing comment (rollout + acceptance run).

## Review

- Correctness: one-line default bump; install-job argv test parameterizes the
  pin, no test pinned the default.
- Security: no new surfaces; the install job still hard-gates the installed
  version against the pin.
- Compatibility: the gate accepts ≥ pin, so already-newer installs pass.
- Residual risks: spark agents may carry stale env pins (see Excluded);
  `modelctl-install` on the NAS must run when the queue is idle (one-active
  guard makes collisions fail loudly with 409, not corrupt state).
