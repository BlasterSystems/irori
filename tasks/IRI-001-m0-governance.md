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
- Docs-check: run after skills + README land (see M0 completion).

## Review

- Correctness: spec narrowed strictly to the user's clarified scope; dropped
  features listed explicitly (SPEC §1, §14).
- Security: no auth decision documented with trust boundary (ADR-0002/0003).
- Compatibility: modelctl store untouched (ADR-0004).
- Residual risks: ADR status Proposed pending owner acceptance; brand assets
  land with M1.
