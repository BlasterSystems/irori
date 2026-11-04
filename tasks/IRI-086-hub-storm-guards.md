# Task: Hub restart-storm detection + process-level guards (IR-179 / IRI-086)

## Objective

The hub must observe its own crash/restart pattern and survive unexpected
async failures: a health rule that flags per-node reconnect storms (the
IR-176 incident's 489 `node-online` journal events went unseen), plus
`unhandledRejection`/`uncaughtException` handlers that log structured
diagnostics and bump counters instead of dying silently.

## Product manager summary

- **One-liner:** Hub warns on reconnect storms and logs (rather than dies on)
  unexpected rejections/exceptions, with /metrics counters.
- **User value:** A stuck agent is visible within minutes via health status
  and webhook alert; a stray rejection no longer costs the hub its uptime.
- **Business impact:** Fleet uptime + earlier detection of agent-side bugs.
- **Success metric:** Simulated reconnect bursts trip the rule and fire the
  webhook; a forced rejection logs and the process survives.
- **Dependencies & constraints:** IR-176 (incident), IRI-069 (health rules +
  webhook alerts + /metrics), existing health service shape.

## Acceptance criteria

- [x] Per-node `node-online` journal rate ≥ N per 5 min ⇒ warn/critical
      health finding, webhook alert fires (existing alert path).
- [x] `process.on('unhandledRejection')` + `on('uncaughtException')` log
      structured diagnostics (5xx-diagnostics pattern) and increment
      /metrics counters; the process survives rejections (uncaughtException
      logs + exits non-zero per Node guidance — guard first, crash cleanly).
- [x] Tests: simulated reconnect bursts trip the rule; forced rejection
      logs + survives.

## Scope

### Included

- apps/server/src/health service rule + alert wiring.
- apps/server/src/index.ts process handlers + /metrics counters.
- Tests in apps/server/test/.

### Excluded

- Agent-side changes (IRI-085).
- New alert channels (reuse existing webhook).

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Validation evidence (2026-11-04)

- Seeded rule "Reconnect storm" (metric `reconnect_storm`, gte 10 per 5 min,
  warn, 600 s cooldown) — auto-seeds on existing DBs via ensureSeed's
  onConflictDoNothing; threshold calibrated from the incident (≈31/5 min)
  vs deploy blips (1–2).
- `EventJournalService.countByNodeSince(type, sinceMs)` (drizzle GROUP BY on
  the journal) feeds the rule through a new optional `journalCounts` health
  sink; the 30 s sweep evaluates it per node with the existing
  finding/journal/webhook/cooldown machinery.
- `apps/server/src/process-guards.ts` — `installProcessGuards({log, proc?})`
  with a counters registry; index.ts installs it at boot (rejections
  survive, exceptions log then `exit(1)`); app.ts passes `guardCounters()`
  into the /metrics renderer (`irori_process_unhandled_rejections_total`,
  `irori_process_uncaught_exceptions_total`).
- Tests: health-ir69.test.ts — real journal bursts grouped by countByNodeSince;
  a 12-event burst trips the rule, fires the webhook (fetch spy), and a
  quiet window clears the finding. process-guards.test.ts — fake process:
  rejection → log + counter + no exit; exception → log + exit(1).
  Suite: server 366/366 (db-gated on the shared test PG).

## Residual risks

- The storm rule reads journal events, so journaling disabled ⇒ rule inert
  (sweep skips gracefully when the sink is absent).
- `uncaughtException` still exits by design — the supervisor restart is the
  recovery; the counters/journal make the *cause* visible post-restart.

## Architecture impact

No — additive observability on the existing IRI-069 health/alert surface and
standard Node process-handler practice. No ADR.
