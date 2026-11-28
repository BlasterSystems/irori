# Branch: feat/iri-173-store-link-visibility (epic IR-288)

## Business context

On 2026-11-28 a sync from the NAS store to DGX-4 failed in under a second with modelctl's "has no active NAS reference". The model was fine. modelctl on the NAS node writes ordinary symlinks into the store's `active/` folder, and the Sparks' SMB mount shows those links as directories, so every sync from the store fails on every Spark. Irori offered **Sync** anyway and gave no explanation. The owner decided to keep one store writer on the NAS and fix how Sparks read the store (epic IR-288). Research: `tasks/research-sync-local-smb-symlinks.md` and `tasks/research-store-node-ownership.md`.

This branch carries the epic's Irori stories, one commit per ticket.

## What changed

### IR-289 / IRI-173: Irori sees what each node sees

- A node's inventory now lists the store entries it cannot see as links (`store.unlinkedActive`), with a warning on the node page.
- The Models page no longer offers **Sync** to a node that cannot see the model's link. It shows the reason, without the disk-cleanup link, or offers a push when another node holds the model.
- Setup transfers skip the NAS sync for such a node and fall through to a push or a Hugging Face download.
- Before `sync-local` starts, the agent checks the store link and fails at once with a plain message: share not mounted, model not active, link hidden by the mount, or a mount that does not answer. modelctl is not started.

## Business rules and constraints

- A node must see `active/<model>` as a symlink to sync from the store.
- Unknown is not a verdict: a node without a report, or with an older agent, keeps today's behaviour, and the agent's check is the backstop.
- The agent's check blocks only on proof. Any other read error is left to modelctl, which runs as the cache user.
- Irori still never writes to the store except through modelctl (ADR-0004).

## Edge cases handled

- A model the node does not list yet (still downloading) is judged by the rest of its view: if every listed model is hidden, the new one will be too.
- A slow mount costs only the new field, not the node's store view.
- A job settle resets the node's inventory; the hub remembers the last store view until the next report so the gate does not forget.
- Cancelling during the check settles the job as canceled without starting modelctl.

## Integration impact

- Agent and hub ship together; the new report field is optional, so older agents and hubs interoperate. No schema change.
- No modelctl change in this story.

## Out of scope and follow-ups

- IR-290 / IRI-174: store writes need a safe store view (ADR).
- IR-291 / IRI-175: modelctl resolves the model without a visible symlink.
- IR-292 / IRI-176: spike on the NAS pushing models straight to Sparks.
- The NFS export of the QNAP share is an operations step, not code.

## Verification

- `pnpm test` with a throwaway Postgres 17: core 143, proxy 24, db 16, web 606, agent 410, server 556, all passing.
- `pnpm typecheck`: exit 0.
- Independent adversarial review: pass with findings; all fix-before-merge findings resolved (see `tasks/IRI-173-store-link-visibility.md`).
- Not yet checked on the dev hub; that needs a deploy.

## Changelog

- fix(agent,server,web): detect store links a node cannot see; gate NAS sync and pre-check sync-local (IR-289 / IRI-173).
