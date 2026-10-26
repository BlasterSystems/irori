# Task: Discard the Activity drawer; stream job output into Telemetry

## Objective

Replace the global Activity drawer (IRI-028: topbar badge + modal) with
Telemetry streaming on the Overview page: job lifecycle lines already ride the
feed; the throttled `job-progress` output lines now stream into it too
(deduped per line, node + kind context from the seeded jobs map). Web-only —
the SSE frames and the `/api/v1/jobs` seed endpoint are unchanged.

## Acceptance criteria

- [x] `ActivityDrawer.vue` deleted; no topbar activity button/badge;
  `runningJobs`/`runningJobCount`/`sortJobs`/`isActiveJob` removed (dead with
  the drawer).
- [x] `job-progress` lines enter the web feed ring only when the line changes
  and the job is known; feedLines renders node, kind, and the line (context
  fallback to the frame's node id).
- [x] Overview telemetry cap raised 30 → 120 (bounded, scrollable) so 1/s
  progress does not evict every other event class.
- [x] Tests updated: live store ring behavior, overview feedLines, jobs
  helpers.
- [x] SPEC §11 and ARCHITECTURE wording updated.

## Scope

### Included

- apps/web: App.vue, ActivityDrawer (deleted), jobs.ts, live.ts, overview.ts,
  OverviewView.vue, tests.

### Excluded

- Server changes (frames + seed endpoint unchanged). The server ring keeps
  excluding progress frames — the output tail is live-only by design.
- NodeDetail/ModelsView job polling (component-local, untouched).

## Plan

- [x] Map drawer surfaces (App badge, jobs helpers, SSE wiring)
- [x] Implement feed streaming + removals
- [x] Tests + docs
- [x] Validation

## Architecture impact

- **ADR required:** No — UI reshuffle of an existing telemetry path; no
  schema, deployment, dependency, or integration change (owner decision
  superseding IRI-028's option-A choice, recorded in SPEC/IR-102).
- **Relevant ADRs:** 0006 (telemetry-first pipeline), 0008 (SSE contracts
  unchanged)
- **Proposed ADR:** None

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — pass
- Tests: web 238 passing (live store: changed progress lines enter the ring, identical repaints deduped, unknown-job frames ignored, lifecycle still rides it; overview feedLines: progress rendering with and without job context; jobs helpers pruned with their tests)
- Build: `pnpm build` green (all workspaces)
- Documentation check: `.agentic/bin/docs-check` — pass (SPEC §11 job-activity bullet, ARCHITECTURE.md browser link, server/events-feed comments)

## Review

- Correctness: lifecycle job lines were already in the feed; progress lines
  are deduped per line and bounded by the ring cap; unknown-job frames never
  enter the ring.
- Security: no new surfaces; the drawer's cancel button is gone (cancel
  remains on the Models drawer and NodeDetail as before).
- Compatibility: SSE contracts and `/api/v1/jobs` unchanged; the Overview
  telemetry cap rises 30 → 120 (owner-approved in IR-102).
- Residual risks: progress lines are live-only (server ring excludes them) —
  a reload keeps lifecycle lines and the seeded last line, not the full tail.
