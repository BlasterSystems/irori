# Task: IRI-064 - Serve page UX overhaul (truthful chips, Running now, a11y)

Jira **IR-152** (Parts B + C of the IRI-053 brief; the state-machine layer is
IRI-063 / IR-151, merged first — this ticket is presentation only and changes
no state machine). Expert review of the Serve page found cards contradicting
their own state chips, duplicated vocabularies, missing feedback, and
accessibility gaps.

## Change
- `apps/web/src/serve.ts` (pure helpers):
  - `setupChipView` replaces `setupChipCls`: failed renders warn (distinct
    from stopped), `foreign` → "wrong engine", stopped splits into
    "never started" / "stopped", and a probe-detected falsely-stopped row
    (IR-151 escape hatch) reads `serving :PORT` in warn.
  - `setupNodeLines` is status-aware (P1): stopped/failed render idle muted
    chips ("idle"/"offline") — no green JOINED/no-probe vocabulary on a dead
    setup; `probeSees` keeps a falsely-stopped head honest.
  - `sortSetupsForBoard` (running → failed → idle, name-stable),
    `setupSummaryLine`, `engineLogEmptyText` (per-state honest empty),
    `scriptPathError` (tilde/relative rejected with actionable copy),
    `workerCapHint` (cap from core `MAX_SETUP_NODES`),
    `runningEnginesFromProbes` (probe truth only),
    `applySetupStates` (setup-state SSE overlay; stale frames never revert a
    newer row — the 2.5 s poll stays convergent).
- `apps/web/src/dialog.ts` (new): `v-dialog` — Escape (document-level,
  stack-gated so nested dialogs close topmost-only), initial focus, Tab
  focus trap, focus restore. Applied to drawer + wizard panels.
- `ServeView.vue`: pagehead summary; Running-now section (every detected
  engine, managed-by link / unmanaged + Adopt → wizard prefilled, lands on
  Scripts); board from `board` computed (SSE overlay + ordering); card
  Start/Stop + drawer header Start/Stop with per-action in-flight refs
  (startingId/stoppingId/removingId, double-submit guarded); Remove in-flight;
  drawer `aria-modal`, header actions, fail-line visible, honest Engine log
  label + explained empty; placement step reuses `placementChip` (Models-page
  vocabulary); worker checkboxes disable at the cap with an inline hint;
  step dots navigate back to visited steps; pre-save rules + automatic head
  `test -x` on Next (Step 3) — DOA paths never save; error banner above the
  sticky footer; copy sweep (Configuration header, no test -x / timeout 15 m
  / endpoint / stale "Pull from HF" leaks).
- `irori.css`: `.input/.select:focus` ring rides `--ink` (+16 % wash) — the
  danger token `--thread` is reserved for danger (App-wide DS change).
- SPEC §7 UI-scale bullet updated with the Running-now contract.

## Verification
- Web suite: 10 new/updated pure-helper tests (chip honesty incl.
  failed≠stopped, idle chips, ordering, summary, SSE freshness + newest-wins,
  script-path rules, cap hint, log empty states, runningEngines). Full
  workspace 861 green; build/typecheck/validate/docs-check.
- Browser (fixture router, built dist, dark + light): summary line; Running
  now managed/unmanaged + Adopt; STOPPING chip flipped instantly from the
  events ring; FAILED warn + reason on card and drawer; GHOST stopped row
  renders `serving :8099` + working Stop (IR-151 pair); Start 3× → one POST
  with disabled "Starting…" (Stop/Remove same); tilde paths get field errors
  + banner and Next refuses, then auto-validates on head (placement step
  shows shared `present`/`needs sync` chips); worker 8th checkbox disabled +
  hint; step dots navigate visited, lock unvisited; drawer/wizard focus
  trapped (25 Tabs inside), Escape closes from body focus and restores focus
  to the trigger; computed focus ring border `rgb(237,239,242)` = `--ink`,
  rule pinned from the served stylesheet.

## Notes
- `:focus-visible` (keyboard outline on all controls) keeps `--thread` — the
  finding was the focused-valid INPUT reading as errored, not keyboard focus
  visibility.
- Running now lists probe-detected engines only; configured-but-unanswered
  ports belong to the Overview (a port with nothing answering is not running).
