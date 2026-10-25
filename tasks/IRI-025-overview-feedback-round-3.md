# IRI-025 — Overview feedback round 3 (range filter, power chart + cost, tokens, settings UX)

- **Ticket:** epic IR-89, stories IR-90..IR-95 (sprint 985)
- **Status:** in progress
- **Research:** `docs/research/IRI-025-research-brief.md` (decision-complete; approved design `mockups/overview-v3.html`)

## Goal

Owner-approved mockup round on the Overview: range filter for all charts (30m default · 1h · 4h · 24h · week · month), fleet-only power card with an interval bar chart + energy cost, NAS card split with download progress + token usage/cost, hub settings moved to the topbar with a scroll-free 2×2 modal and cost/currency sections, no-data hero adaptation, and a conditional OFFLINE chip.

## Plan

Slices (implemented sequentially per owner preference):

1. **IR-90 (backend)** — ranges: `4h` in `HISTORY_RANGES` (minute), `30m`/`4h` in `ANALYTICS_RANGES` (minute), token ledger writes + prunes minute rows.
2. **IR-91 (backend)** — cost settings service + routes (`energy_cost`, `token_cost`, shared currency) following the cadence pattern.
3. **IR-92 (frontend)** — shell: gear to the topbar (right of theme toggle), footer gear removed, scroll-free 2×2 settings modal with the two cost sections + currency selects, conditional OFFLINE chip.
4. **IR-93 (frontend)** — hero: range seg in the pagehead driving charts/cards, no-data hiding (TTFT/ITL) + running-only queue, truncating heads with serving chip (no duplicate name row).
5. **IR-94 (frontend)** — power card: fleet-only, interval bar chart with 240 W envelope + window average, energy/cost stats from settings.
6. **IR-95 (frontend)** — NAS card split: store + live download progress row above, Tokens·range (input/cached/output/cost) below.

## Validation evidence

- `pnpm typecheck` green across all six packages; `pnpm build` green.
- `pnpm test`: core 78 (incl. new cost-schema bounds), web 216 (incl. the new
  range/fleet/energy/token helper tests + updated shell/hero source pins),
  proxy 22, agent 140, server 96 node-only.
- Db-gated server suite **179/179** on a disposable Postgres container
  (`irori-local-pg-test` recipe), including the minute-ledger assertions.
- `.agentic/bin/validate` passed; SPEC §9/§13 updated (tokens ledger
  granularities, cost settings routes); docs-check otherwise clean.
- Live smoke on the built stack (local server + disposable PG, browser-driven):
  - Cost routes round-trip; analytics accepts `range=4h` (minute granularity).
  - Overview: range seg 30m/1h/4h/24h/week/month with live relabel + refetch
    on switch (ENERGY · 4H / COST · 4H / TOKENS · 4H verified).
  - Power card fleet-only (no NAS row), envelope + average dashed lines,
    cost "≈ €0.00" from the persisted setting.
  - NAS card split: store above, Tokens · 30m below; download row hidden while
    the queue is idle.
  - Settings modal opens from the topbar gear: 2×2 sections, prefill
    0.35/EUR from the setting, no vertical scroll (scrollHeight == clientHeight).
  - Topbar: no status chip while connected; warn "Offline" chip appears when
    the SSE stream drops (verified by cutting the server after load).
  - Screenshots light + dark at 1568 px verified; 0 console errors.

## Deploy

- (pending)
