# feat/iri-158-node-provisioning (IR-272 / IRI-158)

## Business context

A freshly installed node never got modelctl. On the dev hub, DGX-4 (cache user `piresbruno`, pin 0.25.0) reported no local caches, so the hub had nothing to provision, and the node page didn't offer the install button. An operator had to know to create an HF cache folder by hand, or wait for a daily read. The same happened whenever the model cache user changed. Setting up a node should finish moments after the installer does.

## What changed

- **The node's model user is always visible.** The inventory reports the configured cache user, or root when none is set (the NAS), even before it has an HF cache or modelctl.
- **The hub converges setup when it matters.**
  - It reads the inventory when an agent comes online and its node isn't set up.
  - It reads it when the cache user is set or changed, after the agent has the new value.
  - It reads it again after every successful modelctl install.
  - The existing auto-install then installs `uv` and modelctl for each user who needs it.
- **Full per-user setup.** The modelctl install also creates the user's `~/.cache/huggingface/hub`.
- **rsync up front.** Serving nodes (not the NAS) get the idempotent `ensure-rsync` once per hub process, instead of after a failed push.
- **No pin is no longer a dead end.** With no hub pin, missing binaries install at the agent default, now 0.24.0.

## Business rules and constraints

- Hub-pinned versions only. Installs are version-gated and never downgrade.
- One active job per node. A busy node is retried when its job settles, or within 2 minutes.
- No loops: at most one auto-install per node and user per 30 minutes, and a failing `ensure-rsync` retries after 6 hours.
- Below-pin upgrades still need a hub pin.

## Edge cases handled

- The agent comes online while another job runs: the step waits and runs right after.
- A cache user change for an offline node: the next hello picks it up.
- A cache user cleared or unchanged: nothing is dispatched.
- An install that succeeds but doesn't fix the report (custom `IRORI_MODELCTL_PATH`): the cooldown stops it repeating.
- A cache user with no passwd entry: not reported, nothing dispatched for it.

## Integration impact

- Agents need this bundle to report the configured cache user. Older agents keep working: the hub re-reads their inventory on each hello, and the result is the same as before.
- No schema, API, or protocol change.

## Out of scope and follow-ups

- Transfer keys stay reactive (ADR-0014).
- A pin field in the hub's settings window.
- Re-reading inventories right after a pin change.

## Verification

- `pnpm test`, `pnpm build`, `pnpm -r typecheck`. New tests in `apps/server/test/provisioning-ir272.test.ts`, `apps/agent/test/inventory.test.ts` and `apps/agent/test/m4.test.ts`.

## Changelog

- feat: provision node dependencies on agent install and on model cache user changes.
