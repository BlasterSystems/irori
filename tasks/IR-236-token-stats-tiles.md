# Task: Token stats — full-width row, drop Average-per-hour and Busiest tiles

Jira: IR-236 (story of epic IR-233, round 9). Research: `tasks/research-ds-v14-ui-feedback-round-9.md`.

## Objective

The Token stats card must stop wasting half its row and shed its two low-value tiles: full-width `card section-gap` row (the Fleet clock caps idiom), `statgrid--3`, six tiles.

## Product manager summary

- **One-liner:** Token stats spans the content row with six tiles (Total, Generated, Prompt, Cache hit, Output:input, Cost).
- **User value:** No dead space right of the card; the eight-tile dilution is gone.
- **Business impact:** Overview density/legibility; owner-ranked polish.
- **Success metric:** Card width = content row width at full tier; exactly 6 tiles incl. the coverage state.
- **Dependencies & constraints:** None; web-only. The busiest-bucket insight remains on Analytics (owner ranked it unimportant here).

## Acceptance criteria

- [ ] Full-width row; `statgrid--3`; exactly 6 tiles (and 6 in the fleet-null coverage state)
- [ ] `overviewTokenTiles` opts param, `tokenGranularity`, `tokenBuckets`, `busiestBucket` deleted
- [ ] `tokens-data.test.ts` updated; markup pins unaffected (hero-grid pin still satisfied by the serving/power sections)
- [ ] Overflow clean 320–1920

## Scope

### Included

- `apps/web/src/tokens-data.ts`, `apps/web/src/components/OverviewView.vue`, `apps/web/test/tokens-data.test.ts`

### Excluded

- Analytics tokens lens (keeps its own busiest surfaces)
- The Power|NAS hero-grid pairing (untouched)

## Plan

- [x] Inspect wrapper/tiles/tests; confirm `fmtBucket`/`analyticsRangeMs` have other uses (feed lines, prev-window fetch)
- [x] Architecture impact: none (no ADR)
- [x] Implement wrapper + tiles + cleanup
- [x] Update tests
- [ ] Validate + browser-verify

## Architecture impact

- **ADR required:** No
- **Relevant ADRs:** None

## Validation evidence

- Configuration validation: pending
- Tests: pending
- Build: pending
- Documentation check: pending

## Review

- Correctness: the removed computeds had no other consumers (grep-verified)
- Security: n/a
- Compatibility: tier behavior — small 2-col / ≤1100 3-col / full 3-col come from the existing shared statgrid media rules
- Residual risks: none known
