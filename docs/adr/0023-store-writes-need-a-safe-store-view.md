# ADR-0023: Store writes run on the NAS node, or on a mounted node only with a write-safe store view

- **Status:** Accepted
- **Accepted:** 2026-11-28 — owner approval after the IRI-174 review loops (strict rule chosen by the owner; guard coverage and re-check recorded in `tasks/IRI-174-store-write-safety.md`)
- **Date:** 2026-11-28
- **Decision owners:** Bruno Pires
- **Scope:** Model store writers: store-node selection for store-mutating jobs, the hub's job dispatch guard, the download queue
- **Tags:** modelctl, nas, downloads, jobs, storage, safety
- **Supersedes:** None
- **Amends:** [ADR-0009](0009-server-side-download-queue-nas-placement.md), for the placement fallback only ("any other online node with the store mounted"). ADR-0009 stays Accepted, and its queue, batching and reconcile decisions are unchanged; see the amend rule in `docs/adr/README.md`.
- **Superseded by:** None

## Context

ADR-0009 sends store writes to the NAS-kind node and falls back to "any other
online node with the store mounted (the CIFS route)" when the NAS node is not
available, so downloads survive a NAS-agent outage.

On 2026-11-28 a sync from the store failed on every Spark. The cause:
modelctl on the NAS node writes ordinary symlinks into the store's `active/`
folder on the QNAP's own filesystem, and the Sparks' SMB mount shows those
links as directories (`tasks/research-sync-local-smb-symlinks.md`). The
fallback writer of ADR-0009 is exactly such a Spark. If the NAS node goes
offline, store writes run through a mount on which:

- every active entry looks like a directory, which modelctl's update path
  treats as a foreign copy to repair (`operations.py:155-180`; the effect
  through an SMB-followed link is untested);
- new links would be written as mfsymlink marker files next to the NAS
  node's ordinary symlinks, so each kind of client would be blind to the
  other's links;
- modelctl has failed before: this store once gained 1.47 TiB of directory
  copies when written over the SMB mount (modelctl
  `plans/active-reference-integrity.md`).

The owner decided on 2026-11-28 to keep one store writer on the NAS node
(`tasks/research-store-node-ownership.md`). That leaves the fallback rule to
settle.

## Decision drivers

- A wrongly allowed read fails loudly; a wrongly allowed write can damage a
  multi-terabyte store. Writes need the stricter rule.
- modelctl's store guarantees (atomic rename, verified symlinks, locks,
  fsync) are made on a local filesystem.
- Irori already observes how each node sees the store (IRI-173:
  `store.unlinkedActive` in the inventory).
- Downloads surviving a NAS-agent outage is useful, but not at the cost of
  the store.
- The rule must hold on every dispatch path, including the generic jobs
  endpoint.

## Considered options

### Option 1: Keep ADR-0009's fallback unchanged

Any online node with the store mounted may write. Highest availability; it
is the hazard described above.

### Option 2: NAS node only, no fallback

Simplest and safest. A NAS-agent outage stops every store write even when a
Spark has a perfectly good view of the store (for example over NFS with
visible symlinks).

### Option 3: Fallback only with a write-safe store view (chosen)

The NAS-kind node is always allowed. A node that only mounts the store may
write only when its latest inventory gives positive evidence of a clean view:
a catalog-sourced store view with no warning, that lists at least one model,
in which no `active/` entry is seen as a directory, and that is no older
than the daily inventory sweep allows (26 h). No report, an older agent, a
single hidden entry, an empty view, a warning, a scanned view or a stale
report all mean no. Costs: writes wait while the NAS node is down and
no such node exists, and a little more code.

### Option 4: Tolerant fallback

As option 3, but allow a few hidden entries or a scanned view. One stray
directory copy would not block the fallback, but modelctl's update path
would then try to repair that entry through the network mount. Rejected by
the owner (2026-11-28) in favour of the strict rule.

## Decision

Option 3, with the strict rule.

- `storeViewSafeForWrites` (`packages/core`) is the one definition of a
  write-safe view. Unknown is not safe. This is the opposite of the read
  gate of IRI-173, where unknown keeps today's behaviour.
- `pickStoreNode` takes an optional write-safety predicate. With it, the
  non-NAS fallback must satisfy the predicate; without it, the pick is for
  reading and display, unchanged.
- `isStoreWrite` (`packages/core`) names the jobs that change the store:
  `download-queue`, `nas-delete`, `nas-delete-apply`, `nas-delete-batch`,
  `catalog-refresh`, `repair-active-apply`, `gc-objects`, `cleanup-staging`,
  `sync-cards`, `quarantine-prune`, `prune-cleanup-quarantine`;
  `hygiene-clean` when it includes the `modelctl-staging` category; and
  `download` on a node that mounts the store (modelctl writes its
  configured root). Dry-run kinds that share a verb with an armed one are
  refused too, as `nas-delete` already was.
- The hub refuses such a job on a node that is not NAS-kind unless that
  node's store view is write-safe. The check sits in the jobs service's
  `create`, which every dispatch path uses.
- Setup transfers do not plan an HF download onto a node that sees the
  store's links as directories; with nothing to push from, that target is
  skipped with the reason.
- The download queue asks the jobs service for the current store writer.
  With none, entries stay pending and drain when one is available.
- `GET /api/v1/store-writer` reports the current writer, or the reason there
  is none. The Models page sends store changes to that node and shows the
  reason; read-only checks still go to any node with the store.

## Consequences

### Positive

- A Spark with an SMB view of the store can no longer write it, on any path.
- A Spark with a proven clean view still covers a NAS-agent outage.
- The rule is two pure functions with tests. The queue asks the hub, and
  the hub's guard is the enforcement, so the web's local pick (kept for
  display and reads) cannot cause an unsafe write.

### Negative

- A NAS-kind node is required to start a store. A fleet whose only store
  node is a Spark that mounts an empty store has no writer, because an empty
  view is not evidence (ADR-0009 allowed that topology). Register the store
  host as a NAS-kind node.
- A setup transfer to a node that sees the store's links as directories,
  with no node to push from, fails for that target with the reason; no HF
  download is planned onto it.
- With the NAS node down and no write-safe node, downloads and store
  deletes wait. Today's fleet (Sparks on SMB) has no write-safe fallback, so
  until the Sparks' mounts show symlinks, the NAS node is the only writer.
- A model-mutating job settle drops a node's inventory. The hub remembers
  the dropped store view in memory, but after a hub restart a fallback node
  is unsafe until its next report.

### Risks and mitigations

- A node's view changes between its report and the write (mount remounted
  over SMB). Reports are re-read when older than 24 h (hourly sweep) and on
  node-page reads, and a view older than 26 h is not accepted, so the window
  is at most about a day. modelctl's own symlink probe and activation checks
  remain the last line of defence. Requesting a fresh inventory before every
  fallback dispatch would close the window and is a revisit trigger.
- A legitimate operator action on a mounted node is refused. The refusal
  names the node and says to run it on the NAS node or refresh the node's
  inventory.
- A new job kind that writes the store is not covered until it is added to
  `isStoreWrite`. The core test iterates every job kind against a list of
  decided reads and a list of decided writes, so a new kind fails the test
  until someone classifies it.
- `repair-active` (the dry run) and the audits stay allowed on any node;
  they are read-only in modelctl.

## Implementation and validation

IRI-174 (IR-290): `packages/core/src/downloads.ts` (`storeViewSafeForWrites`,
`pickStoreNode` predicate, `STORE_WRITE_KINDS`), `apps/server/src/jobs-service.ts`
(`pickStoreWriter`, dispatch guard), `apps/server/src/download-queue-service.ts`,
`GET /api/v1/store-writer`, `apps/web` Models page.

Rollback is a plain revert: no schema change.

Validation: core policy tests (NAS always; fallback only when write-safe;
strict rule cases); db-gated tests for the dispatch guard, the remembered
view, the queue waiting with the NAS node offline and draining on its
return, and a write-safe Spark taking over. Live check after deploy: with the
NAS agent stopped, `GET /api/v1/store-writer` returns `nodeId: null` with the
reason, and a queued download stays pending.

## Revisit triggers

- Sparks mount the store with visible symlinks (NFS): confirm a Spark then
  qualifies as fallback writer, and decide whether that is wanted.
- A fallback write goes wrong on a view that was up to a day old: request a
  fresh inventory before fallback dispatch.
- modelctl gains a multi-writer or remote-store mode.
- The store node stops being a single node (store-side push, IRI-176).

## References

- Task `tasks/IRI-174-store-write-safety.md`; epic IR-288.
- Research: `tasks/research-store-node-ownership.md`,
  `tasks/research-sync-local-smb-symlinks.md`.
- ADR-0004 (modelctl as supply-chain engine), ADR-0009 (amended here),
  ADR-0003 (jobs).
