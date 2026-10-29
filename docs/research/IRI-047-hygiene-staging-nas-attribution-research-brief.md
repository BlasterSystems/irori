# IRI-047 research brief — disk hygiene shows NAS staging cleanup on compute nodes

- **Date:** 2026-10-29
- **Ticket:** IRI-047 (proposed — next free number in this checkout; IRI-047..122 may exist outside it, confirm before filing)
- **Owner question:** DGX1's Disk hygiene drawer lists "modelctl staging ◇ care — 3 items — 236 GB" with three `orphaned` rows whose paths are all `/mnt/nas/.staging/...`. Two questions: where is the CTA, and why does DGX1 show cleanup opportunities that belong to the NAS?

## 2. Current state (evidence)

### What the drawer shows

The pasted block is the per-node Disk hygiene drawer (`apps/web/src/components/CleanupDrawer.vue`), opened from the node page's "Disk hygiene" button (`apps/web/src/components/NodeDetail.vue:635-636`) or from ServeView's capacity offer "Clean up disk — est. +N GB" (`apps/web/src/components/ServeView.vue:824-827`). Row anatomy:

- Header chips: `Disk {{ diskPct }}%` + `{{ fmtBytes(totalReclaimable) }} reclaimable` (`CleanupDrawer.vue:197-199`).
- Category row `modelctl staging` with `◇ care` chip for `safe: false` rows (`CleanupDrawer.vue:245-247`), item count, bytes, rationale, then the detail rows — `label` is the staging-audit entry status (`orphaned`), full path, bytes (`apps/agent/src/hygiene.ts:71-90`, `stagingAuditToCategory`; details capped at 12, `MAX_DETAILS`).

### Where the CTA is

By design there is **no per-row or per-item CTA**. The audit rows are checkboxes (`<label class="pick"><input type="checkbox">`, `CleanupDrawer.vue:225-262`): safe categories pre-checked, care rows (docker images, HF cache, modelctl staging) opt-in. The only destructive CTA is the sticky bottom bar (`CleanupDrawer.vue:271-298`, `.hy-confirm` IRI-042): tick the `modelctl staging` row → type the node name → `Clean N categories`. SPEC §11.6 pins this flow: "audit → typed node-name confirm → staged streamed run (no dry-run plan CTA; **the audit is the plan**)" (`docs/SPEC.md:381-383`), with per-target details added by IRI-028 (`docs/SPEC.md:378-381`). So the drawer answers "how much and what" with rows, and the action lives in the one gated bar — a discoverability gap, but an intentional one.

### Why NAS staging appears on DGX1

The staging category is **not local disk** — it audits whatever store root the node has configured:

- `auditHygiene` runs `modelctl staging-audit --json --root <nasRoot>` **on the agent** whenever `ctx.nasRoot && ctx.modelctlPath` (`apps/agent/src/hygiene.ts:388-409`).
- `nasRoot` comes from the node's last config-update: "NAS store root from the last config-update (model-ops nodes)" (`apps/agent/src/transport.ts:197-200`; wired in `apps/agent/src/main.ts:157`).
- DGX1 mounts the NAS store at `/mnt/nas` and is a model-ops node, so its agent scans `/mnt/nas/.staging` and reports store staging as one of its eight hygiene categories.

The scanned entries are real store junk: `selectCleanableStaging` keeps every status except `resumable`/`journal_referenced` (in-flight update data, protected per SPEC §11.6, `apps/agent/src/hygiene.ts:53-56`), so the three `orphaned` entries (202 + 28.2 + 5.8 GB = 236 GB) are genuinely cleanable. This category exists because the NAS held ~500 GB of staging junk (IRI-008 brief, `docs/research/IRI-008-research-brief.md:14-18`). Cleaning goes through modelctl, never raw rm: re-audit → `modelctl cleanup-staging <paths> --apply --root <root>` (`apps/agent/src/hygiene.ts:633-653`), and the protected set also realpaths the NAS root itself out of the rm-based cleaners (`apps/agent/src/hygiene.ts:255-256`). The clean works from any node holding the mount.

### What is wrong with it

1. **Attribution.** The drawer header mixes store bytes into the node's disk story: `totalReclaimable` sums **all** categories including staging (`CleanupDrawer.vue` computed), and the `Disk N%` chip is `df -kB /` — the root device only (`apps/agent/src/hygiene.ts:494-501`; IRI-027/SPEC: the card's DISK row is the device disk, `docs/SPEC.md:355-357`). Cleaning the 236 GB frees NAS volume space and **zero** bytes on DGX1. The only node for which this row is honestly attributed is the NAS store node itself.
2. **Duplication.** Nothing scopes the audit to the store node: every model-ops node with `nasRoot` + `modelctlPath` reports the same store staging in its own drawer and persists it in its own `cleanup_runs` (`apps/server/src/jobs-service.ts:282-290`). `[INFERENCE]` DGX2/DGX3 (if mounted the same way) show the same 236 GB. It also re-runs `staging-audit` over CIFS per node (120 s timeout each, `hygiene.ts:396`).
3. **Weekly pass unaffected.** Prevention's weekly pass covers `HYGIENE_SAFE_CATEGORIES` only — staging is never auto-cleaned (`apps/server/src/cleanup-service.ts:103-105`, `docs/SPEC.md` prevention copy). Duplication is display/report cost, not double-deletion risk.

## 3. Gap analysis

| Gap | Consequence | Fix surface |
|---|---|---|
| Staging bytes count toward a compute node's reclaimable total beside a root-disk chip | "est. +236 GB" implies DGX1 disk relief that never materializes | server filter or web display |
| No store-node scoping | N drawers show the same store staging; N audits over CIFS | server (jobs-service / node config) or agent config flag |
| Row says "under the NAS store root" but sits in a node disk context | User confusion (this report) | web copy + scope badge |

## 4. Proposed design

**Decision: scope the `modelctl-staging` category to the store node, keep the typed-confirm clean flow unchanged.**

- **Option A (recommended): store-node attribution, server-side.** The server already has a store-node concept (NAS-preferred `pickStoreNode`, IRI-014/ADR-0009). Filter the `modelctl-staging` category out of audit reports for non-store nodes before persisting/displaying, and render it only in the store node's drawer with a "NAS store" scope label. No agent config change; audit cost on compute nodes remains (wasted but bounded) unless also gated agent-side later.
- **Option B (minimal, display-only):** keep auditing everywhere; in `CleanupDrawer.vue`, exclude staging bytes from the node's `totalReclaimable`, drop the root-disk-adjacent framing, and badge the row "NAS store — frees space on the store volume, not this node". Cheapest; leaves duplicate audits and duplicate persisted reports.
- **Option C (rejected): per-item delete CTA on detail rows.** Contradicts the SPEC §11.6 single-gate design (audit is the plan, typed confirm is the only destructive gate) and duplicates `modelctl cleanup-staging` which already takes an explicit path list.

CTA discoverability (no visible button until the bottom bar): fold a one-line hint into the care-row copy or the header sub-line during the same web change; no structural change to the confirm flow.

## 5. Phased plan

Single task (not an epic):

1. **Server:** store-node scoping/filter for `modelctl-staging` in audit persistence + `GET /api/v1/nodes/:id/cleanup` (Option A) — with a repo test (server tests already cover hygiene persistence, `apps/server/src/test/m7.test.ts`).
2. **Web:** `CleanupDrawer.vue` — scope badge, exclude store-scoped staging from per-node totals, CTA hint line; extend `chrome-markup.test.ts` / `ds-markup.test.ts` guards.
3. **Docs:** SPEC §11.6 staging paragraph + CHANGELOG; task file `tasks/IRI-047-*.md` from `tasks/task-template.md`.

## 6. Risks & open questions

- Confirm the NAS node runs an agent + modelctl so store-side staging keeps a home after scoping (IRI-014 says it exists; verify its config). If the store agent is offline, staging orphans become invisible — acceptable? (fallback: keep last non-store audit flagged stale).
- Which option: A (server scoping, slightly bigger) vs B (display-only). Decision needed before implementation.
- `[INFERENCE]` Verify DGX2/DGX3 config (both `nasRoot` and `modelctlPath`) to size the duplication claim.
- Numbering: confirm IRI-047 is free in the tracker (this checkout tops out at IRI-045 task files + an IRI-123 brief from another stream). **Resolved 2026-10-29:** this work was filed as IRI-046 but collided with the Overview density task file (IRI-046, shipped same day via PR #70); renumbered to IRI-047 in PR (see `tasks/IRI-047-hygiene-staging-attribution.md` Notes).

## 7. Jira overlap

None applicable: iroi tracks work as `tasks/IRI-NNN` files + `docs/research/` briefs (`docs/DEVELOPMENT_PROCESS.md`); no `CAR`/MWA epic applies. The skill's Jira steps are inert for this repo.
