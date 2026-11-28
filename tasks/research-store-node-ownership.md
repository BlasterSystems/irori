# Research: who should own the NAS model store — the QNAP-hosted node, Irori, or a distributed design?

## Tracker target

Jira project **IR** (local task id `IRI-<n>`), resolved from `AGENTS.md`
and recent commit subjects.

**Tickets (created 2026-11-28, after owner approval):**

| Ticket | Local id | Scope | Priority |
|---|---|---|---|
| [IR-288](https://blastersystems.atlassian.net/browse/IR-288) | — | Epic: one store writer on the NAS, Sparks that can always read it | Medium |
| [IR-289](https://blastersystems.atlassian.net/browse/IR-289) | IRI-173 | S1: observed link visibility, Sync gating, `sync-local` pre-check (phase 1) | High |
| [IR-290](https://blastersystems.atlassian.net/browse/IR-290) | IRI-174 | S2: store writes need a healthy store view; ADR amending ADR-0009 (phase 2) | High |
| [IR-291](https://blastersystems.atlassian.net/browse/IR-291) | IRI-175 | S3: modelctl `sync-local` journal-based resolution; pin bump (phase 3) | Medium |
| [IR-292](https://blastersystems.atlassian.net/browse/IR-292) | IRI-176 | S4: spike, store-side push (phase 4) | Low |

The modelctl code for S3 lands in the `BlasterSystems/modelctl` repository;
it is tracked in IR, following the IR-265 precedent.

## Summary

**Question.** A guest on the QNAP exists only to run modelctl (and the Irori
agent) next to the store. Should it be removed, with the store becoming
Irori's responsibility, or should the system become distributed with
modelctl changes?

**Answer.** Keep one store writer on the QNAP, and do not distribute
writes. The guest is not the source of truth; the files on disk are. What
the guest provides is a **local filesystem** under modelctl, and every
store guarantee modelctl makes (atomic rename, verified symlinks, `flock`,
`fsync`) depends on that. Each alternative moves the writer onto a network
mount, which is where modelctl's own history shows the failures.

The real weakness is the **read path**: Sparks read the store through SMB,
which hides the symlinks (see `tasks/research-sync-local-smb-symlinks.md`).
The work worth doing is there, in three steps of increasing size:

1. Irori checks what each node can actually see and stops falling back to
   a Spark as store writer.
2. modelctl's `sync-local` stops depending on the client seeing a symlink.
3. Optionally, the store node pushes models to Sparks itself, so Sparks no
   longer mount the store at all.

## Current state (evidence)

### What the store node does

- **Role in the docs:** "one NAS node that owns the `modelctl` model store"
  (`docs/ARCHITECTURE.md:10`); "The NAS node runs the same agent; its
  `nasRoot` points at the modelctl store" (`docs/SPEC.md:249`).
- **Jobs that land on it:** the download queue (`apps/server/src/download-queue-service.ts:191`),
  store deletes and store hygiene from the Models page
  (`apps/web/src/components/ModelsView.vue:186-187, 664`), hygiene
  (`apps/server/src/cleanup-service.ts:92`), and setup transfers' HF
  download stage (`apps/server/src/setups-service.ts:985, 1036-1042`).
- **Selection rule:** `pickStoreNode` takes the `nas`-kind node first, then
  **any other online node with `nasRoot`** — "the CIFS route"
  (`packages/core/src/downloads.ts:107-121`).
- **It is the only node on a local filesystem.** Its `/mnt/llms` is
  `/dev/mapper/cachedev4[/LLMs]`, ext4 (observed 2026-11-28). The owner
  confirmed the guest is a full VM on the QNAP, with the volume folder
  passed through.

### Where the truth lives

- modelctl's store is self-describing on disk: `models/` (immutable
  objects), `active/` (symlinks), `state/` (journals), `.staging/`,
  `.locks/` (`~/source/modelctl/src/modelctl/layout.py:18-43`).
- `catalog.json` is derived, and Irori's `model_meta` is a cache of it
  (`docs/ARCHITECTURE.md:33`, `docs/API.md:294-299`).
- So removing the guest moves **no truth**. It only changes which machine
  executes modelctl, and through which filesystem.

### What modelctl needs from the filesystem under a writer

- Per-model and catalog `flock` in `.locks/`
  (`layout.py:82-104`, `catalog.py:242-250`).
- Atomic symlink replace plus verification (`layout.py:173-187`), and
  staging on the same filesystem as the final object (`layout.py:137-144`).
- Its changelog records repeated CIFS-specific failures: lock files
  unwritable under another SMB principal, `fsync` denied on SMB,
  caching and root-squash errors (`CHANGELOG.md:98-99, 149-150, 167`).
- A prior incident on this very store, written through the CIFS mount:
  ten `active/` entries became 1.47 TiB of directory copies, the cause was
  never identified, and quarantined trees did not survive a rename on the
  share (`~/source/modelctl/plans/active-reference-integrity.md`).

### What modelctl needs from a reader

- `sync-local` requires `active/<name>` to be a symlink as the client sees
  it: `if not reference.is_symlink(): raise … "has no active NAS
  reference"` (`hf_cache.py:468-479`). This is the 2026-11-28 failure.
- `push` can only read from the local Hugging Face cache, never from the
  store ("The source is always the local Hugging Face cache",
  `README.md:586-600`). So the store node cannot send a model to a Spark
  today; a Spark must first `sync-local` through a mount.

### Decisions already on record

- ADR-0004 rejected reimplementing the store natively (option 2, "the
  highest-risk code in the system") and rejected serving model operations
  from the hub (option 3, "wrong place for the work").
- ADR-0009 moved downloads onto the NAS node because a Spark's CIFS mount
  was "a pointless extra hop", and kept the mounted-Spark fallback so
  downloads survive a NAS outage.
- modelctl has an older plan for itself as a central control plane over
  SSH (`plans/central-cluster-model-management.md`, written for version
  0.4.0). Irori now fills that role; the plan was not implemented (no
  `cluster` commands in `cli.py`).

## Gap analysis

1. **Read path depends on protocol symlink semantics.** One SMB server
   setting breaks every sync, silently.
2. **The fallback writer is unsafe today.** If the NAS node goes offline,
   `pickStoreNode` sends store writes to a Spark over CIFS. That Spark sees
   all 85 active entries as directories. modelctl's update path treats a
   directory there as a foreign copy to repair
   (`operations.py:155-180`) `[INFERENCE: effect through an SMB-followed
   link not tested]`. Two link formats in one store (POSIX symlinks from
   the NAS node, mfsymlink marker files from a CIFS writer) would also
   leave each kind of client blind to the other's links.
3. **Nothing in Irori names the writer.** "Store node" is a side effect of
   node kind plus mount configuration, not a declared, checked role.
4. **Sparks need a store mount only for one read operation.**

## Proposed design

### Options considered

| # | Option | Verdict |
|---|---|---|
| A | Keep one writer on the QNAP; fix the read path | **Recommended** |
| B | Remove the guest; a Spark writes the store over CIFS (today's fallback) | Rejected |
| C | Remove the guest; the hub mounts the share and runs modelctl | Rejected |
| D | Remove modelctl from the NAS; Irori implements the store natively | Rejected |
| E | Distributed: any mounted node may write | Rejected |
| F | modelctl changes to the read path | **Recommended, complements A** |

- **B (Spark writes over CIFS).** Already rejected in ADR-0009 for the
  extra hop. It also holds a Spark's single job slot for the length of a
  download (`apps/server/src/jobs-service.ts:369`), puts the writer on the
  filesystem where modelctl has failed before, and creates the mixed link
  formats of gap 2.
- **C (hub writes).** ADR-0004 option 3. The hub is a Docker container on
  Proxmox (`docs/DEPLOYMENT.md`, LXC 106) with no job runner; jobs execute
  in agents. In practice this means "an agent on another host with the
  share mounted": option A with a worse filesystem and every HF byte
  crossing one more machine.
- **D (native store in Irori).** ADR-0004 option 2. It trades a small
  guest for owning atomic publish, journals, ETag validation and repair,
  in two implementations that must stay compatible.
- **E (distributed writers).** Needs cross-client locking that holds over
  SMB or NFS, one link format every client reads, and conflict handling.
  The fleet has one store and one operator; nothing today is limited by
  having a single writer.

### Recommended direction

**A. One declared store writer, on the QNAP.** Keep modelctl executing on
the store's local filesystem. The guest is a full VM and stays as it is.

**Irori takes these responsibilities** (this is the part of "make it
Irori's responsibility" that holds up):

1. **Observed store health per node.** The inventory reports whether
   `active/` entries are visible as symlinks; placement and setup transfers
   use it; `sync-local` gets an agent preflight. This is the ticket already
   drafted in `tasks/research-sync-local-smb-symlinks.md`.
2. **Store writes never fall back to a node that can't see the links.**
   `pickStoreNode` keeps its NAS-first rule, but for mutating jobs a
   non-NAS fallback must have a healthy store view; otherwise the queue
   waits and says why. This amends ADR-0009's fallback and needs an ADR.
3. **Documented read mount.** `docs/DEPLOYMENT.md` states the supported
   Spark mount (NFS read-only from the QNAP, pending the test in the
   symlink research).

**F. modelctl changes** (separate repository, in this order):

1. **`sync-local` resolves the object without a client-visible symlink.**
   When `active/<name>` is not a symlink, derive the canonical object from
   the state journal's last successful activation, require it to be inside
   `models/`, and validate it with the existing `validate_object`. The
   directory at `active/<name>` is never used as the source, so the
   invariant from the active-reference plan holds. Small, read-only change;
   makes syncing independent of SMB/NFS symlink behavior.
2. **Store-side push (larger, optional).** Let the store node send an
   active store object to a Spark's cache over SSH, reusing `push`'s
   handshake and `receive-cache` commit. Sparks would then need no store
   mount at all, and the SMB question disappears. It needs transfer keys
   from the store node (ADR-0014 already manages those), an ADR in Irori
   for the changed transfer topology (ADR-0009, ADR-0014), and a throughput
   check: the NAS is not on the RoCE fabric (`docs/SPEC.md:180`).

## Phased delivery plan

Ordered by rollout safety. Ticket keys are in the table at the top
(phase 1 = IR-289, phase 2 = IR-290, phase 3 = IR-291, phase 4 = IR-292).

1. **Phase 0 — operations (no code):** NFS read-only export of `LLMs` to
   the Sparks; verify `stat` shows `symbolic link`; retry the DGX-4 sync.
2. **Phase 1 — IR ticket (proposed IRI-173):** observed link visibility in
   the inventory; placement and setup-transfer gating; `sync-local`
   preflight. Acceptance criteria are in the symlink research document.
3. **Phase 2 — IR ticket + ADR (proposed IRI-174):** store writes require a
   healthy store view; no blind fallback to a mounted Spark. Done when
   `pickStoreNode` tests cover NAS offline with a Spark whose store view is
   unhealthy (queue stays pending with a reason) and healthy (fallback
   still works), and the ADR amending ADR-0009 is accepted.
4. **Phase 3 — modelctl issue:** `sync-local` journal-based resolution
   (F1), then a pin bump in Irori.
5. **Phase 4 — spike, decision later:** store-side push (F2) and whether
   Sparks keep a store mount.

## Risks and open questions

- **Q1 (answered 2026-11-28):** an AI agent session rewrote all the links
  on Nov 9 at 23:36, in one batch as root. It was not an Irori job or a
  modelctl release. That batch is the likely point where syncing from the
  store stopped working (not confirmed: job history was cleared).
- **Q2 (answered 2026-11-28):** the guest is a full VM on the QNAP. It
  stays; shrinking it is not planned.
- **Q3 (answered by the decision):** the owner accepted keeping the store
  node, so the motivation for removing it no longer needs an answer.
- **Q4 (answered 2026-11-28):** the NAS-to-Spark link is 1 Gb Ethernet.
  Any transfer from the NAS, SMB sync or store-side push, is limited to
  roughly 110 MB/s (about 80 minutes for a 510 GB model). A store-side
  push would remove the Spark mount; it would not be faster.
- **Risk:** phase 2 trades availability for safety: with the NAS node
  down, downloads wait instead of running through a Spark. Proposed
  default: accept that, because the fallback is unsafe with today's links.

## Overlap findings

- `tasks/research-sync-local-smb-symlinks.md` (2026-11-28) covers the
  failure that prompted this question; its proposed ticket is phase 1 here.
- Jira search (`project = IR`, open; sync-local, nasRoot, NAS mount) found
  nothing.
- modelctl `plans/central-cluster-model-management.md` overlaps with Irori's
  role and is not implemented; `plans/active-reference-integrity.md` is
  implemented and is the precedent for phase 3's invariant.

## Spike IRI-176 (IR-292): store node pushes straight to Sparks

Status on 2026-11-28: desk analysis done; fleet measurements still open.

### Question

Should the store node send a store model directly into a Spark's Hugging
Face cache over SSH, so Sparks need no store mount?

### Findings from the modelctl source (0.25.0)

- **`push` is transport plus a source adapter.** `push_model` resolves
  `(name, metadata, files, commit, overlay)` through `_cache_source`, then
  probes the remote, rsyncs a file list into the remote staging directory,
  and asks the remote `receive-cache` to validate and publish
  (`src/modelctl/remote.py:310-421`). Only `_cache_source` knows where the
  bytes come from (`remote.py:138-196`).
- **The overlay imitates a store object.** `_cache_source` builds a
  temporary directory with `.modelctl.json` and
  `.cache/huggingface/download/*.metadata`, "so the remote `receive-cache`
  path validates and publishes the transfer unchanged" (`remote.py:141-147`).
  A real store object already has that layout: `sync-local` reads the same
  ETag files from it (`hf_cache.py:_store_file_etags`).
- **So a store-sourced push needs no overlay.** A `_store_source(root, name)`
  that returns the active object, its metadata and its ETags (all three
  already computed by `sync_cache`) can feed the unchanged transport and
  remote commit. modelctl's README records that `push` read from the NAS
  store before 0.12.0 (`README.md`, Versioning), so this restores an older
  source rather than inventing one.
- **Estimated size `[INFERENCE: not prototyped]`:** one new source function,
  a `--from-store ROOT` option on `push`, and tests with the existing fake
  SSH runner. No change to `receive-cache`, so Sparks on 0.25.x can receive.

### What it would change in Irori

- **Placement:** a new route "push from the store node" for a Spark that
  has no reachable local holder. It would replace `sync` for Sparks without
  a store mount. `planPlacement` already models push sources as
  `viaNodeIds`; the NAS pseudo-entry would become a real push source.
- **Jobs:** the push runs on the NAS node and holds its one job slot. A
  510 GB push at 1 GbE takes about 80 minutes, during which downloads and
  store deletes on the NAS node wait. Today the same sync holds the
  *Spark's* slot instead. This is the main cost.
- **Keys:** the NAS node needs a transfer key the Sparks accept. ADR-0014
  already has the hub install node-local transfer keys for pushes; the NAS
  node would join that set.
- **Users:** modelctl on the NAS node runs as root and dials
  `cacheUser@host`, as Spark-to-Spark pushes do (ADR-0011).
- **ADRs touched:** ADR-0009 (the NAS node becomes a transfer source, not
  only the download target) and ADR-0014 (keys on the NAS node).

### Throughput

- The NAS-to-Spark link is 1 Gb Ethernet (owner, 2026-11-28). The SMB sync
  and an rsync-over-SSH push share it, so neither can exceed roughly
  110 MB/s. A store-side push is not faster than today's sync.
- Not measured: the actual rate of each on the fleet. SSH encryption on the
  QNAP VM's CPU could make the push slower than SMB. `push` already
  disables SSH compression (`remote.py:44-51`). This needs one timed
  transfer of the same model each way.
- Once any Spark holds a model, the CX7 push between Sparks stays the fast
  route (IR-100), so the 1 GbE hop is paid once per model either way.

### Recommendation

Conditionally yes, as a follow-up and not urgently.

- **Why yes:** it removes the only reason Sparks mount the store, and with
  it the whole class of mount problems behind this epic (SMB symlinks,
  wedged mounts, cache-user permissions on the share).
- **Why not urgent:** after IRI-175 (modelctl 0.25.1) the SMB sync works
  again, and an NFS mount also fixes it without code.
- **Condition:** the timed comparison shows the push is not materially
  slower than the SMB sync, and holding the NAS node's job slot for the
  length of a transfer is acceptable.

### Proposed follow-up stories (not created)

1. modelctl: `push --from-store ROOT`, release.
2. Irori: transfer key for the NAS node (ADR-0014 path) and a
   "push from store" placement and setup-transfer stage; ADR amending
   ADR-0009 and ADR-0014.
3. Irori: make the store mount optional on Sparks (`nasRoot` null) and
   retire `sync-local` from placement once 2 is proven.

### Still open before closing the spike

- The timed SMB-sync versus SSH-push comparison on the dev fleet.
- The owner's view on the NAS job-slot cost.
