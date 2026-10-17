# Task: IRI-001 — M0 Governance, spec, ADRs, process, branding

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M0)

## Objective

Establish the governed repository: agentic-bootstrap scaffold, authoritative
narrowed spec, decision ADRs, adapted development process with
implement/research skills, and the Irori brand definition — so that M1 starts
from agreed ground truth.

## Acceptance criteria

- [x] agentic-bootstrap scaffold (`--platform all`) applied; `.agentic/bin/validate` green.
- [x] `docs/SPEC.md` — narrowed authoritative spec (workers/head card split,
      NAS+modelctl supply chain, agent responsibilities, analytics lenses,
      benchmarks, non-goals, deferred list).
- [x] `docs/PLAN.md` — epic with milestones M0–M7, deliverables, exits, risks.
- [x] ADR-0001…0006 drafted from the template and indexed.
- [x] `docs/DEVELOPMENT_PROCESS.md` adapted; `implement` + `research` skills created.
- [x] README with project overview and status.
- [x] Screen mockups for approval: `mockups/` (index, overview, node-head,
      models, serve, analytics, benchmarks) — BlasterSystems DS token port +
      fonts from uptime-monitoring recipes; browser-verified light/dark.
- [ ] ADRs accepted by the owner (status flip + commit).
- [ ] Brand assets: `apps/web/public/favicon.svg` + lockup tokens defined (M1 lands
      the files; this task fixes the recipe: canonical mark 30×10 header size,
      "Irori" Fira Sans 600 + DM Mono caps endorsement, ink-tile favicon per
      ADR-0005).

## Scope

### Included

- Docs, ADRs, process, skills, scaffold, brand recipe. Old `SPECSHEET.md`
  superseded and removed.

### Excluded

- Any runtime code (M1+); DS port implementation (M1).

## Plan

- [x] Research: agentic-bootstrap flow, matterhorn implement/research process,
      BlasterSystems DS + uptime-monitoring port, four source projects.
- [x] Scaffold + validate.
- [x] Write SPEC/PLAN/ADRs/process/skills/README.
- [ ] Owner review → accept ADRs.

## Architecture impact

- **ADR required:** Yes — ADR-0001…0006 are this task's output.
- **Relevant ADRs:** all.
- **Proposed ADR:** 0001–0006.

## Validation evidence

- Scaffold: `init --dry-run` → 30 CREATE, 0 conflicts; apply → "Bootstrap
  applied successfully. Post-apply validation passed."; `.agentic/bin/validate`
  exit 0 "Configuration validation passed".
- Mockups: served locally, full-page screenshots of every screen in light and
  dark (headless Chromium); zero console errors; visual defects found and
  fixed (stat-sub collisions, value wrap, hero stretch, ANSI artifact, chart
  fill tone).
- Expert review (UX designer + PM, 2026-10-16): both reviews applied —
  added Nodes screen (registry, add-node wizard, first-run state), Jobs strip
  (progress/ETA/cancel), removed deferred gateway endpoints, sync-from-NAS
  remediation, thread-budget fixes (single filled button per screen, no
  thread fills, ghost row-level danger), halt dot for terminal states,
  contrast ramps for chart series, legend/y-axis fidelity, tablist ARIA,
  hover/disabled states, 1080px reflow, unified-memory data contradiction,
  running/waiting vocabulary.
- Round 2 (2026-10-17, per mockups/PLAN.md): Models v2 (search/filters/
  sort incl. recently-added via `first_seen_at`, pagination, detail drawer,
  download modal, hygiene popover — no inline form walls) + Serve v2 (setup
  cards for 1–8 node fleets, staged transfer progress, detail drawer) +
  `setup-wizard.html` (5 steps, cluster variant, staged progress, validation
  states). SPEC §6/§7/§13 + PLAN M4/M5 amended; serving model simplified to
  "setups" (recipe folders/git-drift dropped from v1 UI).
- Round 3 (2026-10-17, PM LiteraryWoodpecker + UX InvolvedRabbit): disk
  hygiene UI designed and mocked — `cleanup.html` drawer (audit checklist →
  plan → typed arm → staged run → result, history tab, prevention per node),
  threshold chips + DISK barrows on overview, Disk hygiene… + 91% kv on
  node-head, placement tie-ins in models drawer + cleanup result. SPEC §11.6
  UI contract; IRI-008 acceptance extended.
- Round 4 (2026-10-17, PM CurlyGull + UX SoreRooster, mobile 390px captures):
  mobile tiers 720/480 in irori.css (two-row scrollable topbar, stacked
  pageheads, 1-col grids, full-bleed drawers/sheets + sticky wizard footer,
  44px targets, .card__body--flush table scroll w/ sticky first column,
  hyrow/stage/hyhist regrids, chart vector-effect + .chart class, viewport-
  fit metas) + Analytics **Temps lens** (fleet strip shape-tiered ◇/▫,
  fleet-max GPU/CPU charts with 85/90 guides + throttle/crossing markers,
  7d minute buckets). SPEC §4/§9; PLAN M2; IRI-002/IRI-008.
- Docs-check: run after skills + README land (see M0 completion).

## Review

- Correctness: spec narrowed strictly to the user's clarified scope; dropped
  features listed explicitly (SPEC §1, §14).
- Security: no auth decision documented with trust boundary (ADR-0002/0003).
- Compatibility: modelctl store untouched (ADR-0004).
- Residual risks: ADR status Proposed pending owner acceptance; brand assets
  land with M1.
