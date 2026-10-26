# Task: IRI-028 — Node models, per-node delete, hygiene detail, job activity

**Jira:** IR-99 (IR Sprint 2; Story)
**Feedback:** owner messages on dev-0.3.0-31, 2026-10-26 (node detail models +
delete error + hygiene detail + lost download log).

## Objective

1. **Node detail lists models.** Show what is actually on the node — the
   modelctl store (when `nasRoot` is set) and every local HF-cache
   registration, per user — with size, repo and runtime, and let the user
   delete any row from that page.
2. **Deletes are safe and diagnosable.** A store delete preflights the object
   tree's writability before deactivating the model, so an ACL/permission
   denial leaves the model active instead of orphaning its data. Failed
   deletes from before the fix are listed as leftovers with a `gc-objects`
   recovery action.
3. **Disk hygiene shows what and how much.** Each audit category exposes its
   concrete targets (old images, HF incomplete/unreferenced split, staging
   entries, compiler dirs, journal/tmp/cores) with per-target bytes. The
   dry-run plan CTA is removed; audit → select → typed node-name confirm →
   run, with the streamed per-category outcome table.
4. **Job activity survives the modal.** A global Activity drawer (topbar)
   lists active and recent jobs across nodes, streams the output tail, and
   offers cancel; SSE gains a `running` job frame and a throttled
   `job-progress` frame. Leaving a download modal no longer loses the log.

Research: [IRI-028 brief](../docs/research/IRI-028-research-brief.md) —
storage classes and per-user local caches (§1), why `node_models` lies (§2),
the `CACHEDIR.TAG` failure and recovery (§3), hygiene detail sources (§4),
job activity gap (§5), inventory data path (§6).

## Acceptance criteria

- [x] Node detail shows a **Store** card when the node has `nasRoot`:
      active models (name, repo, runtime, size) with a filter and a scroll
      cap, plus failed-delete leftovers with the object path, error and size.
- [x] Node detail shows a **Local caches** card listing each discovered
      user cache (`user · cacheDir`), its registrations (name, repo, runtime,
      size or `—`), and per-cache errors (modelctl missing, list failed).
- [x] Deleting a store model runs `nas-delete-apply` on that node behind a
      confirm dialog; deleting a local row runs `delete-local` as the cache
      owner; deleting a leftover runs `gc-objects` with its three-part path.
      Every action shows job status, streamed output tail and cancel, and
      refreshes the inventory on settle.
- [x] `nas-delete-apply` preflights every object/staging directory with a
      create+unlink probe before `--apply`; a denied tree fails the job with
      the failing path and errno, and the model stays active.
- [x] Disk-hygiene category rows render per-target details with bytes; the
      "Plan clean (dry run)" CTA and plan table are gone; the typed node-name
      confirm gates the real run.
- [x] Topbar Activity button shows the running-job count and opens a global
      drawer listing active then recent jobs (node, kind, status, elapsed,
      last output line, expandable output, cancel). It is reachable from
      every page and survives route changes.
- [x] SSE emits `job` with `status: "running"` on dispatch and a throttled
      `job-progress` frame (≤1/s per job); older web bundles ignore both.
- [x] `GET /api/v1/jobs?limit=` returns recent jobs across nodes with the
      last output line; `GET/POST /api/v1/nodes/:id/models[/refresh]` serve
      and refresh the cached inventory.
- [x] Agent < 0.4.0 (no `models-inventory` kind) degrades with a visible
      "agent update required" message, not a blank card.
- [x] Tests: core schemas/events, agent inventory + probe + user wrapper,
      server endpoints/persistence/invalidation, web inventory helpers,
      delete-action mapping, feed lines, hygiene details.
- [x] Docs: SPEC §6/§11.6/§13, API.md, CONFIGURATION.md (agent capability),
      research brief linked.

## Scope

### Included

- `packages/core` — inventory schema, `models-inventory` job kind, hygiene
  `details`, `job` running status + `job-progress` event.
- `apps/agent` — inventory builder (store + per-user local + failed-delete
  journals), `models-inventory` runner, `nas-delete-apply` preflight runner,
  `delete-local` user wrapper, hygiene detail rows.
- `packages/db` — `node_inventory` table + migration.
- `apps/server` — inventory persistence/endpoints/invalidation, jobs list
  endpoint, SSE start/progress frames.
- `apps/web` — NodeDetail Models section + confirm + delete jobs; hygiene
  drawer details/no dry-run; global Activity drawer; telemetry feed lines.
- `docs/SPEC.md`, `docs/API.md`, `docs/CONFIGURATION.md`.

### Excluded

- modelctl source changes (native preflight for `gc-objects`/`cleanup-staging`,
  `list --local --json` bytes): follow-up IRI-029 in the modelctl repo + pin
  bump. This task's preflight lives in the agent and covers Irori deletes.
- Placement planner name-keyed `present` semantics for renamed local copies
  (reported, not fixed here).
- Auth/permissions changes on the NAS; the one-time ACL recovery is documented
  in the brief (§3.6), not automated.

## Plan

- [x] Research: [IRI-028 brief](../docs/research/IRI-028-research-brief.md)
      (§1 storage classes, §3 delete failure, §4 hygiene detail, §5 activity).
- [x] Core contracts + tests.
- [x] DB migration + server inventory/jobs/SSE + tests.
- [x] Agent inventory + preflight + user wrapper + tests.
- [x] Web NodeDetail models, hygiene drawer, Activity drawer + tests.
- [x] Docs (SPEC, API, CONFIGURATION) and validation evidence.

## Architecture impact

- **ADR required:** No. The inventory is a read-only projection (no new store
  mutation path); deletes keep using modelctl (ADR-0004). The new job kind and
  SSE frames extend existing contracts additively.
- **Relevant ADRs:** ADR-0003 (root agent), ADR-0004 (modelctl-only store
  mutations), ADR-0006 (telemetry pipeline), ADR-0009 (store-node selection).

## Validation evidence

- Configuration validation: `.agentic/bin/validate` green.
- Tests: `pnpm test` green — core 86 (new `inventory.test.ts`: report schema,
  hygiene details defaults, `models-inventory` kind, running/progress SSE
  frames), agent 163 (new `inventory.test.ts` + `delete-preflight.test.ts`
  incl. a chmod-0555 denial proving the apply never runs, and `m4.test.ts`
  delete-local owner wrapper), server 100 (new route tests: inventory GET/404,
  503 degraded, refresh 202/409, jobs list), web 237 (new `inventory.test.ts`
  + `jobs.test.ts`, live-store job tracking incl. progress-out-of-feed).
- Build: `pnpm build` green (all packages).
- Documentation check: `.agentic/bin/docs-check` green (heuristic warning about
  architecture-significant files — SPEC §6/§11/§13 and API.md were updated in
  this change).
- Browser (vite dev + fixture fetch/EventSource mocks, light and dark,
  0 console errors):
  - Node detail Models: Store card (mount label `/mnt/nas · cifs`, filter,
    per-row size/runtime), the real failed-delete leftover with object path +
    `CACHEDIR.TAG` error + Remove leftover, Local cache card per user with the
    unmeasured size as `—`.
  - Delete confirm → dispatched job → Model operation card streams
    `preflight: …` lines with RUNNING + Cancel.
  - Cleanup drawer: per-target details with bytes/paths, `5 selected · 28.1 GB`
    summary, typed node-name confirm, no dry-run CTA anywhere.
  - Topbar Activity button with running count; drawer lists active first with
    the live progress line, expandable output (fetched ring + newest SSE line)
    and Cancel job.

## Review

- Correctness: the inventory is a read-only projection; deletes keep using
  modelctl (ADR-0004). The preflight mirrors exactly what `shutil.rmtree`
  needs (write+execute on every directory), so a denial fails before
  `reference.unlink()` and the model stays active.
- Security: the per-user `runuser` wrapper resolves binary/home/cache
  agent-side from `/etc/passwd` and accepts only `{name, user}` — no
  request-supplied paths; unknown users/missing binaries fail the job.
- Compatibility: agents older than the inventory kind fail it with
  "unknown job kind", surfaced in the UI as an update hint; older web bundles
  ignore the new SSE frames (the union parse drops them); `job-progress` is
  excluded from the feed ring so 1/s output cannot evict real events.
- Residual risks: local sizes come from an agent-side snapshot walk (a modelctl
  `list --local` `bytes` field would be cleaner — IRI-029); the placement
  planner's name-keyed `present` still misses renamed local copies; the
  existing ACL-denied object still needs the admin recovery documented in the
  brief §3.6.
