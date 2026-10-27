# Task: IRI-034 — Node page UX: ghost probe port, store catalog on spark nodes, CPU clock

- **Ticket:** IR-105 (sprint 990)
- **Status:** implemented; branch `feat/ir-105-node-page-ux`
- **Research:** `docs/research/IRI-034-research-brief.md` (decision-complete)

## Objective

Fix three owner-reported node-page issues:

1. A probe port deleted from the node (8080) keeps rendering in the Inference card as `UNKNOWN IDLE`.
2. The NAS store catalog renders on DGX-1's node page (a spark node that merely mounts the store).
3. The History CPU card shows no clock; the GPU card shows `sm 2,190 / 3,003 MHz`.

## Product manager summary

- **One-liner:** node edits reach the agent immediately, the store catalog renders only on the store node, and the CPU history card shows the current clock like the GPU card.
- **User value:** the node page stops showing engines that no longer exist and stops dumping a 147-model catalog on compute nodes; CPU clock is visible at a glance.
- **Business impact:** small; correctness/polish on the primary ops surface.
- **Success metric:** delete a port → ghost gone within one probe tick without reconnect; DGX-1 page has no Store card; CPU card shows `cpu X / Y MHz`.
- **Dependencies & constraints:** none blocking; the `perCoreMaxClocksKHz` suffix rides the next agent bundle (fleet agents are already pending an update).

## Acceptance criteria

- [ ] `PATCH /api/v1/nodes/:id` with `llmPorts` and `PUT /api/v1/nodes/:id/llm-ports` push a `config-update` to the connected agent (no reconnect needed).
- [ ] The Inference card and `llmSummaryLine` render configured ports plus only *detected* hot-added ports (Overview parity).
- [ ] The node page Store card (catalog, delete rows, leftover banners) renders only when `node.kind === "nas"`.
- [ ] The CPU history card shows a clock note from the live snapshot (`perCoreClocksKHz`, and `perCoreMaxClocksKHz` when present).
- [ ] Tests updated/added; full validation green; docs updated.

## Scope

### Included

- Server: refresh-config push on the two port routes; AppDeps wiring; stale comment fix (`app.ts:711-713`).
- Web: port merge rule in `NodeDetail.vue` + `llmSummaryLine`; Store card gate; CPU clock note + notes loop.
- Core/agent: optional `perCoreMaxClocksKHz` (schema + collector).

### Excluded

- TTL/pruning of per-port history rows (time retention already handles them).
- Range-aggregated clock history (no GPU per-bucket clock exists either).
- A "store mounted here" hint on mounting nodes (follow-up if wanted).

## Plan

- [x] Research: `docs/research/IRI-034-research-brief.md` (decision-complete).
- [x] Fix 1: server push + web render rule.
- [x] Fix 2: Store card gate.
- [x] Fix 3: CPU clock note + agent max-clock capture.
- [x] Tests + docs + validation.

## Architecture impact

- **ADR required:** No (local implementation details; no data/deployment/boundary change).
- **Relevant ADRs:** None.
- **Proposed ADR:** None.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` passed; `.agentic/bin/docs-check` passed (12 changed files, no gaps).
- Tests: web 245/245 (llm-data 22, detail-data 16, card-data contract updated, ds-markup pins added); server 190/190 on a
  disposable Postgres (`irori-local-pg-test`), incl. the new config-push tests; agent collector 28/28; `pnpm build` green
  (vue-tsc included); `pnpm test` green across all packages.
- Live smoke on the built stack + disposable PG (simulated agent on `/agent-ws`, browser-driven):
  - Config push: hello config carried `llmPorts [8080, 8081]`; after `PATCH {llmPorts:[8081]}` a **second config-update
    arrived without reconnect** carrying `[{port: 8081}]`.
  - Ghost render: with the agent still probing 8080 (undetected) and 8081 detected, the node page shows only `:8081`
    (`:8080` absent from the DOM).
  - CPU clock: History CPU card renders `cpu 2,000 / 2,000 MHz` next to the temp band (live snapshot `perCoreClocksKHz`
    + `perCoreMaxClocksKHz`).
  - Store gate: spark node with a store-bearing `node_inventory` row shows **no Store card**; a `kind: nas` node with the
    same row shows the full Store catalog (screenshots captured).
- Documentation check: SPEC §3/§4/§5/§6 updated; CHANGELOG `Fixed` entry.

## Review

- Correctness: push happens after the DB write and reads the fresh row; offline agents are covered by the hello
  config-update on reconnect; the render rule keeps configured idle ports visible (the "no engine answered" vocabulary
  is unchanged for them).
- Security: no new inputs, no credential surface change; config-update payload unchanged in shape.
- Compatibility: `perCoreMaxClocksKHz` is optional end-to-end — old agents keep working, the ` / max` half simply stays
  absent until they update; llm-data contract change is pinned by updated tests.
- Residual risks: history rows for removed ports persist until time retention (accepted, brief §1); the contents of
  `/etc/irori/agent.env` on dgx1 are root-only — a hypothetical `IRORI_LLM_TARGETS` residual would keep probing but the
  render rule hides an idle unconfigured port regardless.
