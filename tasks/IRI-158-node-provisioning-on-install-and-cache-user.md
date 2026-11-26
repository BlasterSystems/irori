# Task: IRI-158 / IR-272 — Provision node dependencies on agent install and on model cache user changes

Ticket: [IR-272](https://blastersystems.atlassian.net/browse/IR-272) (Story). Relates to IR-271 / IRI-157.
Related: ADR-0013 (modelctl convergence), ADR-0014 (self-provisioned push dependencies), ADR-0011 (cache users), IRI-157.

## Objective

When an agent is installed, or a node's **model cache user** is set or changed, the hub makes sure everything
that user needs is in place within seconds: `uv`, a modelctl at or above the hub pin, the user's HF cache
directory, and (on spark nodes) `rsync`. Nobody needs to SSH in or click Refresh.

## Problem (observed 2026-11-26, dev hub)

- DGX-4 was installed fresh and its cache user is set to `piresbruno`. The hub pin is `0.25.0`.
- Its latest inventory lists **no local caches**, version drift is empty, and `uv` is missing. modelctl was never installed.
- **Cause 1 (agent):** `discoverLocalCaches` (`apps/agent/src/inventory.ts`) skips any user without `~/.cache/huggingface`, and never looks at the configured cache user. A new user has no HF cache until modelctl creates one, so it's a chicken-and-egg problem. The node page's "Install modelctl for <user>" button is drawn from the same list, so it doesn't appear either.
- **Cause 2 (hub):** auto-provisioning (`autoProvisionModelctl`, ADR-0013) runs only after a `models-inventory` job succeeds. A new node's first inventory comes from the hourly scheduler, up to an hour after install.
- **Cause 3 (hub):** a cache-user change pushes `config-update` but doesn't start an inventory, so the new user isn't provisioned until the next daily read.
- **Cause 4 (hub):** an empty hub pin disables provisioning without telling anyone.

## Product manager summary

- **One-liner:** A new node, or a node whose cache user changes, is ready to sync and serve models moments after setup.
- **User value:** No SSH, no manual `uv tool install`, no hunting for a Refresh button. A first sync or push works the first time.
- **Business impact:** Makes onboarding new devices reliable and fast.
- **Success metric:** On dev, a freshly installed spark with a cache user configured reports that user's modelctl at or above the pin within 2 minutes of `install-agent.sh` finishing, with no operator action.
- **Dependencies & constraints:** Hub-pinned versions only, never "latest" (ADR-0013). Installs stay version-gated and never downgrade. One active job per node.

## Acceptance criteria

- [x] **Configured cache user always reported.** The inventory includes the node's model user (the configured cache user, else the agent user) even without an HF cache directory or a modelctl binary. Without a binary it reports `modelctlVersion: null` and "modelctl is not installed for this user". *Changed in implementation:* a cache user with no passwd entry (or a home outside `/root` and `/home`) is not reported. The schema requires a home, and `modelctl-install` can't run for that user anyway. Hello re-reads for such a node are throttled to one per 30 minutes.
- [x] **Provisioning on install.** On an agent's hello (after the config-update), the hub dispatches `models-inventory` when the node isn't set up: no report, the cache user not reported, or a missing or below-pin modelctl.
- [x] **Provisioning on cache-user change.** A node update that sets or changes the cache user dispatches `models-inventory` after the config-update has been sent. Clearing it, an unchanged value, and an offline node dispatch nothing; the next hello handles an offline node.
- [x] **Full setup per user.** `modelctl-install` creates `~/.cache/huggingface/hub` as the target user (runuser), before the version gate, so a satisfied install still creates it.
- [x] **rsync on serving nodes.** Spark and gpu-host nodes (not the NAS) get `ensure-rsync` after their inventory, or on hello when already set up. It runs once per hub process per node, and a failure retries after 6 h.
- [x] **Busy node retried.** A busy node keeps the step pending (at most one of each step per node). It retries when any job on that node settles, or on a 2-minute tick. An install that succeeds re-reads the inventory. One auto-install per node and user per 30 minutes prevents loops.
- [x] **Pin unset (owner, 2026-11-26).** Missing binaries are still installed, at the agent default `IRORI_MODELCTL_PIN`, which rises from 0.23.0 to 0.24.0. Below-pin upgrades still need a hub pin.
- [x] **Visible state.** The dispatched jobs appear in the node's job list and the Activity drawer like any job. The existing "Install modelctl for <user>" button now appears for the configured user, because that user is reported with a null version. No new UI.
- [x] **Tests.**
  - Agent: configured user without an HF dir or binary; agent user reported on a node without a cache user (NAS); missing agent binary means a null version; the install script creates the HF dir before the gate, as the user.
  - Server: the `needsProvisioning` cases; hello on a fresh, converged spark or converged NAS; cache-user change; busy pending and flush on settle; the periodic tick; offline drop; re-read after an install; rsync once and its back-off; step order; `autoProvisionModelctl` with no pin and with the cooldown; node update triggers and non-triggers.
- [ ] **Live on dev** (owner-run deploy): reinstall the agent on DGX-4; `piresbruno` reaches modelctl 0.25.0 with no clicks. Changing the cache user to another account converges that account.

## Scope

### Included

- Agent inventory and `modelctl-install` changes.
- Hub dispatch on hello (node not set up) and on cache-user change, with a busy retry.
- Proactive `ensure-rsync` on serving nodes.
- Install button for the configured user (existing button, now reachable).
- Docs: SPEC (inventory and provisioning), DEPLOYMENT (what a new node gets), CHANGELOG.

### Excluded

- Transfer keys and host-key pinning. They stay reactive (ADR-0014), because they're per node pair.
- Creating OS users. The cache user must already exist on the node.
- Upgrades when the pin changes (already handled by ADR-0013 at the next inventory). Making a pin change trigger an immediate inventory could be a small add-on; decide in research.
- A pin field in the hub's settings window (separate UX ticket).

## Decisions (owner, 2026-11-26)

1. **Pin unset:** provision missing binaries at the agent default, raised to 0.24.0.
2. **ADR:** no new ADR. This is an implementation detail within ADR-0013's convergence model (SPEC updated).
3. **NAS node:** its root modelctl is provisioned on install when missing (the agent user is reported when no cache user is set).

## Implementation plan

### Files to modify or create

- `apps/agent/src/inventory.ts` — include the configured cache user (needs the cache user passed in the inventory context).
- `apps/agent/src/modelctl.ts` — `modelctl-install` script creates the HF cache dir.
- `apps/agent/src/main.ts` — passes the cache user into the inventory; `config.ts` — default pin 0.24.0.
- `apps/server/src/provisioning.ts` (new) — triggers, pending steps and retry, `ensure-rsync`.
- `apps/server/src/index.ts` — wires the provisioner (hello, every job settle, 2-minute tick); one shared `inventoryScriptPaths`.
- `apps/server/src/app.ts` — node update: calls `onCacheUserChanged` after the config-update when the cache user changed to a non-empty value.
- `apps/server/src/jobs-service.ts` — `autoProvisionModelctl`: missing binaries with no pin; per-user cooldown.
- No web change: the existing install button and job list cover the visible state.

### Test approach

- Unit tests at the agent and server seams listed in the acceptance criteria. A dev deploy and a DGX-4 reinstall as the live check.

## Architecture impact

- **ADR required:** No (owner decision: detail within ADR-0013)
- **Relevant ADRs:** ADR-0011, ADR-0013, ADR-0014
- **Proposed ADR:** None

## Deployment

- **Deploy-affecting:** Yes. The hub and agent bundle ship together; agents need the new bundle (one-click agent update, ADR-0007) to report the configured cache user.
- **Functional probe:** after the agent update on DGX-4, `GET /api/v1/nodes/<dgx-4>/versions` shows a drift row for `piresbruno` at 0.25.0, with no clicks.
- **Rollback:** revert the commit. Nothing is persisted; the provisioner is in-memory.

## Validation evidence

- Tests: `pnpm test` (core 123, proxy 24, db 16 with 8 skipped, web 566, agent 346, server 505 with 181 PG-backed tests skipped locally and run in CI).
- Build and typecheck: `pnpm build`, `pnpm -r typecheck` clean.
- Lint: touched files at the `main` baseline.
- Docs: SPEC, DEPLOYMENT, CONFIGURATION, CHANGELOG.

## Review

- **Adversarial review (`quality-review`, fresh read-only context): PASS WITH FINDINGS**, no BLOCK. Fixed:
  - **F1:** two concurrent triggers could double-dispatch an inventory read. Steps are now reserved while in flight. Tested with a gated race.
  - **F2:** a user the agent can't report caused a read on every hello (pre-IR-272 bundle, no passwd entry, home outside `/root` and `/home`). Hello re-reads of a node with a report are now throttled to one per 30 minutes. Tested.
  - **U1:** a job racing the hello's config-update ran with the default (null) cache user, so root could look like the model user of a spark and get modelctl and a root HF dir. The agent now forces no user until a config-update has been applied (`getKnownCacheUser`). Tested.
  - **U3:** the new `mkdir` failed an already-satisfied install when `~/.cache` was unwritable. It now warns instead.
  - **F3:** added a hub test that `onNodeOnline` frames follow the hello config-update. It fails when the hooks are reordered (checked).
- **Accepted as is:**
  - **U4:** the `/root` home for the agent's own user (the agent runs as root).
  - **U5:** the NAS root row now completes presence reconcile for the NAS. `node_models` means the local HF cache, and no NAS-sourced presence exists.
  - **F3 (b, c):** the index wiring and settle ordering are covered by reading the code and by the dev live check. CI's PG suite covers the jobs-service settle.
