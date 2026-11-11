# Task: Docs and ops runbook strings for the new signals (IR-205)

Jira **IR-205** (Task, Low, sprint 1004, assigned Bruno). Story S-E of epic
IR-200 — closes the sprint's doc work after IR-202 (db metric), IR-203
(banner), IR-204 (node-disk rows + two ingest fixes) and IR-206 (wedged
mount).

## Objective

One place that says what to DO when each new signal fires, with the banner
hint text matching it verbatim, plus the SPEC health section, the API.md
metric list, and the repo-convention task file.

## Change

- `docs/DEPLOYMENT.md` — new "Signal runbook (IR-200)" section: per-signal ops
  steps (deploy VM and pg host) for `db_unavailable`, `hub_disk_pct`,
  `disk_pct`, `telemetry_gap_s`. The banner hints are substrings of it.
- `docs/SPEC.md` §4 — "Health rules & findings" bullet: wrapped-store ingest,
  fleet gauges once per sweep, pointer SSE frames, the banner surfaces.
- `docs/API.md` health section — the full metric id list (11 ids), the
  banner pointer, and the runbook pointer.
- `apps/web/src/components/HealthBanner.vue` — db hint aligned to the runbook
  wording ("hub data on the page may be stale…").
- `apps/web/test/health-banner-ir203.test.ts` — "banner hint text matches the
  Signal runbook" reads `docs/DEPLOYMENT.md` and asserts the hint fragments
  exist there (IR-196 structural-pin idiom).

## Acceptance criteria

- [x] docs-check green (heuristic + full gate).
- [x] Banner hint text matches the runbook (pinned by test).
- [x] Task file under `tasks/` per the repo convention (this file).

## Validation evidence

- Full gate: typecheck, monorepo tests (incl. the new runbook-match test and
  all banner mounts), build, `.agentic/bin/validate`, `.agentic/bin/docs-check`
  — EXIT 0.

## Review

- Correctness: the runbook documents the LIVE behavior verified this sprint
  (degraded routes answer 503 with db down — IR-202; bounded statfs skips
  wedged mounts — IR-206; est. text comes from the node's cached audit —
  IR-204). No behavioral code changes beyond one hint string.
- Compatibility: docs + test only.
- Residual risks: the runbook names the pg-host probes generically
  (`pg_isready`, `systemctl status postgresql`) — the pg host is the Proxmox
  pgsql VM, whose exact name lives outside this repo.
