# Branch: feat/iri-173-store-link-visibility (epic IR-288)

## Business context

On 2026-11-28 a sync from the NAS store to DGX-4 failed in under a second with modelctl's "has no active NAS reference". The model was fine. modelctl on the NAS node writes ordinary symlinks into the store's `active/` folder, and the Sparks' SMB mount shows those links as directories, so every sync from the store fails on every Spark. Irori offered **Sync** anyway and gave no explanation. The owner decided to keep one store writer on the NAS and fix how Sparks read the store (epic IR-288). Research: `tasks/research-sync-local-smb-symlinks.md` and `tasks/research-store-node-ownership.md`.

This branch carries the epic's Irori stories, one commit per ticket.

## What changed

### IR-289 / IRI-173: Irori sees what each node sees

- A node's inventory now lists the store entries it cannot see as links (`store.unlinkedActive`), with a warning on the node page.
- The Models page no longer offers **Sync** to a node that cannot see the model's link. It shows the reason, without the disk-cleanup link, or offers a push when another node holds the model.
- Setup transfers skip the NAS sync for such a node and use a push from a node that holds the model.
- Before `sync-local` starts, the agent checks the store link and fails at once with a plain message: share not mounted, model not active, link hidden by the mount, or a mount that does not answer. modelctl is not started.

### IR-290 / IRI-174: store changes only where they are safe (ADR-0023)

- Jobs that change the store (downloads, deletes, repair, store cleanup, card sync) run on the NAS node. A node that only mounts the store may run them only when its latest inventory proves a clean, recent view of it.
- The hub refuses such a job on any other node, on every path, with a message naming the node.
- Queued downloads wait when no node may write and start when one can.
- The Models page asks the hub who may write (`GET /api/v1/store-writer`), shows the reason when nobody can, and keeps read-only checks available.
- Setup transfers no longer plan a Hugging Face download onto a node that cannot see the store's links: that download would write the store through its mount. With nothing to push from, that target fails with the reason.

### IR-291 / IRI-175: syncing works on SMB once modelctl is 0.25.1

- modelctl 0.25.1 (separate repository) finds the model from the store's update journal when the mount hides the symlink. The directory the mount shows is never used as the source.
- For a node whose inventory reports modelctl 0.25.1 or newer, Irori offers the NAS sync again even when the node sees the link as a directory, and the hub tells the agent's check to let it through. The node page keeps the warning.
- A node with an older or unknown modelctl keeps the IRI-173 behaviour. The hub pin is how 0.25.1 is rolled out, but the decision is made per node from what it reports.

## Business rules and constraints

- For store changes, unknown means no. For reads (the sync gate), unknown keeps today's behaviour.
- A write-safe view is: read from the catalog, no warning, at least one model listed, no entry seen as a directory, and no older than 26 hours.
- A NAS-kind node is required to start a store.
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
- IRI-175 depends on modelctl 0.25.1 being published before the hub pin is raised; nothing in this branch requires it to run.

## Out of scope and follow-ups

- Publishing modelctl 0.25.1 and raising the hub pin (and later the agent's fallback pin default) are release steps outside this branch.
- IR-292 / IRI-176: spike on the NAS pushing models straight to Sparks.
- The NFS export of the QNAP share is an operations step, not code.

## Verification

- `pnpm test` with a throwaway Postgres 17: core 152, proxy 24, db 16, web 610, agent 412, server 561, all passing.
- `pnpm typecheck`: exit 0.
- Independent adversarial reviews: IRI-173 pass with findings; IRI-174 blocked first, then passed a re-check after fixes; IRI-175 (Irori and modelctl) pass with findings. All fix-before-merge findings are resolved (see the two task files).
- Not yet checked on the dev hub; that needs a deploy.

## Changelog

- feat(agent,server,core): a hidden store link no longer blocks NAS sync on nodes that report modelctl 0.25.1+ (IR-291 / IRI-175).
- docs: store-side push spike findings (IR-292 / IRI-176).
- fix(server,web,core): store writes need a write-safe store view; no blind fallback to a mounted Spark (IR-290 / IRI-174, ADR-0023).
- fix(agent,server,web): detect store links a node cannot see; gate NAS sync and pre-check sync-local (IR-289 / IRI-173).
