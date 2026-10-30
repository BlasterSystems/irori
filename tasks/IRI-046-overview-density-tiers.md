# Task: IRI-046 — Overview density tiers (hero chrome, width tiers, fleet temps)

- **Tickets:** IR-127 (hero chrome), IR-128 (width tiers), IR-129 (fleet temps) — sprint 990 (IR Sprint 2)
- **Umbrella:** [IR-132](https://blastersystems.atlassian.net/browse/IR-132) — the single implementation pickup; children are linked (Relates) and close with it (2026-10-29)
- **Status:** implemented in PR #73 (IR-127/128/129), live on DEV as dev-0.3.0-59 (2026-10-30); Jira evidence comments 25667-25669 + IR-132 closed
- **Mockup:** `mockups/overview-v4.html` + `mockups/PLAN.md` (rounds 3 and 3b are the approved spec)

## Objective

Port the approved round-3b mockup to the shipped Overview page: serving cards
lose all healthy-state chrome and the ttft/itl placeholder line; the page
becomes explicitly tiered (small ≤900 / medium 901–1440 / full >1440) with a
compact small tier, range dropdown and hamburger nav below full; a
fleet-temperatures strip appears above the serving cards on the small tier and
a `hottest` token joins the page head on every tier.

## Product manager summary

- **One-liner:** The Overview shows more per screen: cards drop decorative
  chrome, phones/tablets get a denser tier, and GPU/CPU heat is glanceable on
  small screens where node cards are below the fold.
- **User value:** No permanent placeholder text, no ENGINE/SERVING badges on
  healthy engines, shorter cards on mobile, fleet thermals always visible on
  phones.
- **Business impact:** Small; operator UX on the primary landing page.
- **Success metric:** Owner accepts the changed Overview on DEV at phone,
  laptop, and desktop widths.
- **Dependencies & constraints:** Frontend-only (`apps/web` + `App.vue`
  topbar); no server/agent/core changes. Tier breakpoints must match the
  existing `.hero-grid` 900px collapse.

## Acceptance criteria

- [ ] Hero card head = model title + one mono meta line `tensorfold :8081 ·
      DGX-1 +1 worker` (+ `· unmanaged` for probe-detected engines with no
      setup); zero chips while healthy (no ENGINE/backend/SERVING).
- [ ] The only chip is a state chip: `chip--warn OFFLINE` (probe stale /
      setup died) or `○ starting` (setup loading weights — `starting` setups
      enter `heroProcesses`). Probe-stale engine (data is history) additionally
      gets `card--stale`: thread border, stat values/bars dimmed to .75 with
      labels at full contrast (new vocabulary — no shipped precedent; the
      node-card IR-103 offline treatment already exists and must NOT be
      reused for stale engines).
- [ ] The `ttft · itl appear with the first requests` line is deleted; null
      latency stats simply do not render (grid becomes 4-col).
- [ ] Tier store (`small|medium|full` from 900/1440 px media queries,
      resize-reactive) drives: hero sparkline hidden only on small (shown on
      medium AND full — owner final call); range seg → native `<select>` below
      full (one shared state model); nav row → hamburger disclosure below
      full (`aria-expanded`, Escape returns focus to the button, link
      activation closes, 44 px hit targets).
- [ ] Small tier density: 12 px gutters, 1-col hero, 2-up stats, compact type
      (values 15 px, labels 10 px), 44 px real tap targets preserved.
- [ ] Fleet temperatures card renders only on small, ordered above the hero
      cards: spark nodes only (NAS excluded), hottest first,
      `DGX-1 71°C gpu 62°C cpu`, warn ≥70 °C / crit ≥90 °C in thread-ink,
      offline node → `— OFFLINE` item. Page head gains
      `· hottest 71°C DGX-1` on every tier.
- [ ] Node cards unchanged (shipped IR-103 offline treatment already correct;
      the mockup mirrors it — do NOT port its removed ONLINE chip).

## Scope

### Included

- `apps/web/src/components/OverviewView.vue` (hero head/chrome, placeholder
  deletion, range select, temps card, page-head token)
- `apps/web/src/App.vue` (nav → hamburger below full) + shared tier state
  (`apps/web/src/overview.ts` or a small `tiers.ts`)
- `apps/web/src/assets/irori.css` only where a tier rule genuinely belongs in
  shared CSS (menu, select); per-page rules stay in `<style scoped>`
- `apps/web/test/overview.test.ts` pin updates (the old chips/placeholder
  pins must be deleted, not re-pinned)

### Excluded

- Power/NAS card content, node card internals, telemetry drawer (IR-124),
  Analytics/Usage/Chats range controls (keep their segs).

## Plan

- [ ] Understand requirements and inspect relevant code (mockup is the spec)
- [ ] Confirm architecture impact (none — view layer only)
- [ ] Implement the smallest complete change (IR-127 → IR-128 → IR-129)
- [ ] Add or update tests
- [ ] Update documentation
- [ ] Run validation

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** None

## Validation evidence

- Configuration validation:
- Tests:
- Build:
- Documentation check:
- Browser: tier sweep 320/390/772/900/901/1318/1441 via vite fixtures or the
  DEV hub; chart visible at 901+, hidden at 900; hamburger focus behavior.

## Review

- Correctness:
- Security:
- Compatibility:
- Residual risks:
