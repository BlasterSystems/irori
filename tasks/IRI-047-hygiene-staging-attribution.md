# Task: IRI-047 — scope disk-hygiene staging cleanup to the store node

- **Ticket:** IR-130 (sprint 990)
- **Numbering:** originally filed as IRI-046; renumbered to IRI-047 on
  2026-10-29 because `tasks/IRI-046-overview-density-tiers.md` (Overview
  density, merged earlier the same day via PR #70) already held that number.
  Renumbering commit also updates code comments/test titles, SPEC §11.6, the
  CHANGELOG entry and the research-brief filename.

## Objective

The Disk hygiene drawer must not present NAS store staging as a compute node's
reclaimable disk. The `modelctl-staging` hygiene category is attributed to the
store node only (Option A of the research brief); compute nodes with the store
mounted stop listing duplicate store-staging rows and stop counting store bytes
in their reclaimable totals. Design decisions live in
`docs/research/IRI-047-hygiene-staging-nas-attribution-research-brief.md`.

## Product manager summary

- **One-liner:** Store-staging cleanup opportunities render only in the store
  node's hygiene drawer, correctly labeled, instead of on every node that
  mounts the NAS.
- **User value:** "Clean up disk" offers no longer promise gigabytes that never
  free local space; the 236 GB of store staging shows up once, where it belongs.
- **Business impact:** Avoids duplicate CIFS `staging-audit` scans per node and
  wrong-capacity "Clean up disk — est. +N GB" offers on ServeView.
- **Success metric:** Only the store node's drawer reports `modelctl-staging`;
  its row is labeled as store scope; compute-node audits and totals exclude it.
- **Dependencies & constraints:** Confirm the NAS node runs an agent + modelctl
  (IRI-014) so store-side staging keeps a home; IRI-047 number confirmed free in
  the tracker.

## Acceptance criteria

- [ ] Server scopes the `modelctl-staging` category to the store node: audit
      reports of non-store nodes either never contain the category or it is
      filtered before persistence and before `GET /api/v1/nodes/:id/cleanup`.
- [ ] Store node's drawer renders the staging row with a "NAS store" scope
      label and a hint that cleaning frees store-volume space, not node disk.
- [ ] Store staging bytes are excluded from non-store nodes' `totalReclaimable`
      and from ServeView's "Clean up disk — est. +N GB" offers.
- [ ] Clean flow unchanged: tick row → typed node-name confirm → streamed
      `hygiene-clean` job (SPEC §11.6 gate untouched).
- [ ] Resumable/journal-referenced staging stays protected (unchanged
      `selectCleanableStaging`); weekly safe pass still excludes staging.
- [ ] Repo tests: server scoping test (extend `apps/server/src/test/m7.test.ts`
      style) and web markup guards (`chrome-markup.test.ts` / `ds-markup.test.ts`).

## Scope

### Included

- Server: store-node resolution + `modelctl-staging` scoping in hygiene audit
  persistence and the cleanup read path (reuse the NAS-preferred store-node
  concept from IRI-014/ADR-0009).
- Web: `CleanupDrawer.vue` scope label + hint line; totals exclusion for
  store-scoped categories.
- CTA discoverability hint (one line; no structural change to the confirm bar).
- SPEC §11.6 paragraph + CHANGELOG entry.

### Excluded

- Per-item delete CTA on staging detail rows (rejected, brief §4 Option C).
- Agent-side gating of the CIFS `staging-audit` run (wasted-but-bounded scan
  cost on compute nodes; revisit if it shows up in job telemetry).
- `df`-based totals covering the NAS volume (Disk % chip remains root-device).
- Node card / ServeView capacity logic beyond excluding the scoped category.

## Plan

- [x] Understand requirements and inspect relevant code (brief read; done)
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Architecture impact

- **ADR required:** No — display/persistence scoping within the existing
  hygiene design (SPEC §11.6) and the existing store-node concept; no data
  model, boundary, or deployment change.
- **Relevant ADRs:** 0009 (server-side download queue / NAS placement), 0013
  (modelctl convergence).
- **Proposed ADR:** None.

## Validation evidence

- Configuration validation: `.agentic/bin/validate` — passed.
- Tests: `IRORI_TEST_DATABASE_URL=… pnpm -r test` (disposable
  `irori-test-pg`, postgres:16-alpine) — exit 0: apps/server 24 files /
  215 tests (new: `test/cleanup-service.test.ts` ×5 pure scoping; m7 scoping
  integration ×1, expectations follow the shared-DB `pickStoreNode` answer),
  apps/agent 192, web markup guards including the new IRI-047 block.
- Build: `pnpm build` — exit 0 (server tsc, agent esbuild, web vite).
- Documentation check: `.agentic/bin/docs-check` — no gaps.
- Live smoke: built server (`apps/server/dist`) on a fresh disposable DB;
  `GET /api/v1/nodes/:id/cleanup` — spark node (no `nasRoot`) returns
  categories without `modelctl-staging`; the store node keeps it. Fixtures
  scoped-deleted afterwards.

## Review

- Correctness: scoping happens at read time — stored reports stay factual;
  resolution is identity-based (no online filter), so staging never flickers
  back into compute drawers when the store node goes offline; with no
  resolvable store node nothing is filtered (single-node worlds unchanged).
- Security: read-only filtering inside the existing authenticated route; no
  new agent/command surface, no credential handling.
- Compatibility: response shape unchanged (same fields; category subset for
  non-store nodes) — drawer totals, ServeView "Clean up disk — est. +N GB"
  offers, and the History tab all derive from the filtered categories.
- Residual risks: agents on store-mounted compute nodes still run the CIFS
  `staging-audit` (wasted but bounded — excluded per task scope); the store
  node's own header still mixes store-volume bytes beside its root-disk
  Disk-% chip (out of scope); `pickStoreNode` first-match over multiple
  qualifying NAS-kind rows is unordered — single-store fleets unaffected.
