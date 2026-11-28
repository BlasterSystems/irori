# Research: `sync-local` can't find NAS references because SMB hides the store's symlinks

## Tracker target

Jira project **IR** (local task id `IRI-<n>`), resolved from `AGENTS.md`
(task convention), recent commit subjects (`IR-286 / IRI-171`), and the
project memory note on the mcp-atlassian server.

**Tickets (created 2026-11-28):** the ticket proposed here as IRI-173 is
[IR-289](https://blastersystems.atlassian.net/browse/IR-289), a story under
epic [IR-288](https://blastersystems.atlassian.net/browse/IR-288). The
wider decision is in `tasks/research-store-node-ownership.md`.

## Summary

On 2026-11-28 at 11:15, `sync-local DeepSeek-V4.1-Flash-1017` on DGX-4
failed after 0 s with `modelctl: model 'DeepSeek-V4.1-Flash-1017' has no
active NAS reference`.

The model is intact. On the NAS, every `active/<name>` is a POSIX symlink
into `models/…`. These links were written by modelctl running as root on
the NAS itself. Over the CIFS mount, every DGX sees all 85 entries as
**directories**, because the server resolves the symlinks before the client
sees them. modelctl's `sync-local` needs a readable link to locate the
object, so it finds no reference.

This is fleet-wide, not specific to DGX-4. With the current share and mount
settings, a `sync-local` from the store should fail for **every model**
whose link the NAS wrote. Irori hides the problem: its scanner accepts a
directory as a valid active entry, so the Models page offers **Sync**.

An earlier draft blamed an unmounted share on DGX-4. The checks on DGX-4
disproved that and the draft was replaced; see the evidence below.

## Current state (evidence)

All of the following was observed on 2026-11-28.

- **Failed job (dev hub `GET /api/v1/jobs`):** id `48f4ff0a…`, node DGX-4
  (`ce3a2638`), params `{"name":"DeepSeek-V4.1-Flash-1017"}`, exit 1, ran
  for 0.29 s.
- **NAS side (`/mnt/llms/active`, local filesystem):** every entry listed is
  `lrwxrwxrwx root root … -> ../models/<org>/<repo>/<rev>--<hash>`. Most were
  written at `Nov 9 23:36` in one batch; later ones on Nov 14 and Nov 25.
  The target entry is
  `symbolic link -> '../models/deepseek-ai/DeepSeek-V4.1-Flash-1017/1bae0e10…--972f4d84bfde'`.
- **Client side (DGX-4 `/mnt/nas/active`):** `stat -c %F *` returns
  `85 directory`, 0 symbolic links. DGX-1 shows the same for the target
  entry: `stat` says `directory`, and `readlink -f` returns the path itself.
  The files read fine through that path: 48 safetensors and `.modelctl.json`.
- **Mounts:** CIFS `//nas.as267.com/llms` with
  `nounix,mfsymlinks,reparse=nfs,symlink=mfsymlinks`. DGX-4 uses
  `vers=3.0` (kernel 7.0.0-1025); DGX-1 uses `vers=3.1.1` (kernel 7.0.0-1019).
  Both nodes have the same modelctl (0.25.0, cache user `piresbruno`).
- **Design assumption:** M4 relied on `mfsymlinks`, the CIFS symlink
  emulation, for `queue`/`download` (`docs/research/IRI-005-research-brief.md:10-11`).
  mfsymlinks covers only links created *through* a client mount, stored as
  marker files on the server. Links that modelctl writes on the NAS's own
  filesystem are real POSIX symlinks, and the client never sees them as
  links. The NAS-first download policy sends downloads to the NAS node
  (ADR-0009, `apps/server/src/setups-service.ts:1036-1042`), so this is now
  the normal way links get written.
- **Irori masks it:** `scanStore` accepts a directory as a valid active
  entry ("A validated directory copy — modelctl doctor can repair it",
  `apps/agent/src/catalog-read.ts:129-135`). Placement returns `sync`
  whenever `hasNasRoot && onNas` (`packages/core/src/catalog.ts:201`,
  `apps/server/src/app.ts:2008`). The agent passes the root to modelctl
  without a check (`apps/agent/src/modelctl.ts:250-254, 334-338`).
- **No workaround through Irori:** no node holds this model in a local
  cache (every `GET /nodes/:id/models` report), so placement has no push
  source.
- **Repair is the wrong tool here:** `repair-active` replaces a directory
  copy with a symlink (`docs/research/IRI-005-research-brief.md:38`).
  Through a client mount, it would act on what the client sees, not on what
  the server holds `[INFERENCE: modelctl internals not read]`. It must not
  be run from a DGX for this problem.
- **The modelctl version is ruled out (2026-11-28):** modelctl is 0.25.0
  everywhere observed (NAS root and piresbruno from the hub `versions`
  route; DGX-4 and DGX-1 piresbruno from `--version`), and the pin didn't
  change near Nov 9. On the NAS,
  `find /mnt/llms/active -maxdepth 1 -type f -size 1067c` returns nothing
  and `-type l` counts **85**. Every entry is a POSIX symlink and none uses
  the mfsymlinks marker-file format. The client-side `directory` result
  comes from plain `stat`, before modelctl runs, so no modelctl version could
  change it.
- **Unknown:** whether `sync-local` from the store ever worked after Nov 9.
  Job history was cleared, and the retained history (22 rows) has no
  successful `sync-local`.

## Gap analysis

1. **The root cause is in infrastructure:** the share and mount settings
   don't let SMB clients see server-side symlinks.
2. **Irori treats "listed" as "syncable":** a directory-looking active entry
   on a network mount is reported, planned, and dispatched as healthy.
3. **Error quality:** modelctl's "no active NAS reference" says nothing
   about SMB symlink visibility.
4. **modelctl has a single point of failure:** a client-side
   `sync-local` depends only on readlink, with no fallback through the
   catalog or manifest.

## Proposed design

**Topology, confirmed by the user on 2026-11-28:** the store lives on a
**QNAP** (`nas.as267.com`, 10.0.10.3). The Irori "NAS" node (10.0.10.26)
runs on that QNAP and runs modelctl as root. Its `/mnt/llms` is the QNAP
volume folder itself (`/dev/mapper/cachedev4[/LLMs]`, ext4), mounted
directly rather than over a network share. So modelctl creates POSIX
symlinks directly on the QNAP's ext4, and the QNAP's SMB service presents
them to the DGXs as directories. As of 2026-11-28, NFS exports only
`/Proxmox`; the `LLMs` share (case-sensitive under NFS) needs NFS host
access added for the DGX subnet.

**1. Fix the share (operations, no code). Recommended: mount the store on
the DGXs over NFS from the QNAP instead of CIFS.** NFS shows symlinks to the
client unchanged. The links are relative (`../models/…`), so they resolve
on every client that mounts the whole export. `sync-local` only reads from
the store, and `active/` is `drwxrwxrwx`, so read access holds without
CIFS's forced `uid`/`gid`. To confirm: on DGX-4,
`stat -c %F /mnt/nas/active/DeepSeek-V4.1-Flash-1017` prints
`symbolic link`, and a retried sync succeeds. `docs/DEPLOYMENT.md`
replaces the CIFS fstab line from `docs/research/IRI-005-research-brief.md:10`
with the NFS one. Check that nothing still writes to the store through a
DGX mount: NAS-first downloads (ADR-0009) suggest nothing does.

**Plan B: keep SMB.** Make SMB clients see server-side symlinks through
QNAP's SMB settings. QTS manages its own `smb.conf`, so the setting names
must be checked in the QNAP UI. The general Samba candidates are:

- **SMB3.1.1 POSIX extensions:** Samba `smb3 unix extensions = yes` (and
  `follow symlinks = no` on the share), with the client mounted
  `vers=3.1.1,posix`. Clients then see real symlinks.
- **Reparse points:** Samba reports symlinks as reparse points, which the
  client's `reparse=` handling then reads.

DGX-4 also needs to move to `vers=3.1.1` to match DGX-1. Verify with
`stat -c %F /mnt/nas/active/DeepSeek-V4.1-Flash-1017`, which must print
`symbolic link`, then retry the sync. `docs/DEPLOYMENT.md` gets the required
mount line. `[INFERENCE: both paths need confirming against the NAS's Samba
version]`

**2. Irori detects the problem and explains it (one ticket).**

- **Agent scan:** `scanStore` reports how each active entry is stored
  (symlink or directory). The inventory report adds
  `store.unlinkedActive: number` and emits a warning such as
  `"85 active entries are not symlinks on this mount (SMB symlink visibility?)"`.
  Absent means unknown, for older agents.
- **Placement and setups:** a target whose own store view shows the model's
  entry as a directory gets `unavailable`, with the reason
  `"store link not visible on this node's mount: see the NAS share settings"`,
  in place of `sync`. Setup transfers stop planning a `NAS → node (sync)`
  stage for that node and fall through to the push or download options.
- **Agent preflight in `sync-local`:** a bounded `lstat` of
  `<root>/active/<name>` before modelctl starts. The job fails fast with
  the same plain message when the entry is missing or is a directory.
- **UI:** the Models page shows the reason, and the node's storage line
  shows the warning.

**3. Upstream robustness in modelctl (separate repo, optional).** When
`active/<name>` is a directory, `sync-local` resolves the object through the
manifest's repo and revision instead. File this in the modelctl repository,
not in IR.

**Rejected alternatives:**

- Running `repair-active` per model. The links are already correct on the
  server; repair through the mount risks the data and fixes nothing, since
  the next NAS download recreates the problem.
- Rsyncing the directory view as-is. That bypasses modelctl's
  verification and staging (ADR-0004).
- Making the NAS the push source for every store transfer. It needs
  `modelctl push` to read from the store rather than a local cache
  (unverified), and it changes the transfer topology of ADR-0009 and
  ADR-0014. Revisit only if fix 1 isn't possible.

No ADR is needed for fix 2. If fix 1 turns out impossible and the NAS-push
route is chosen, that one does need an ADR, because it changes ADR-0009's
transfer topology.

## Phased delivery plan

**Phase 0 (operations, now):** apply fix 1, then confirm with `stat` and a
retried sync on DGX-4. This unblocks the user right away.

**Phase 1:** one ticket, proposed **IRI-173**, "Detect store active entries
that aren't visible as symlinks; gate Sync and explain it". Done when:

1. Agent tests cover how entries are stored (symlink, directory, missing)
   and the inventory's `unlinkedActive` count and warning.
2. `planPlacement` and `setups-service` tests show `unavailable` with the
   reason, and no sync stage, for a node that sees a directory entry.
3. An agent test shows the `sync-local` preflight failing without starting
   modelctl.
4. `docs/API.md` (inventory and placement reason) and `docs/DEPLOYMENT.md`
   (required CIFS mount options) are updated.

This is deploy-affecting: new agent bundle and hub, no schema change.
Rollback is a plain revert.

## Risks and open questions

- **Q1 (answered 2026-11-28):** the share is served by the QNAP, and the
  Irori NAS node is a VM on it (10.0.10.26 has no `smbd`). Still to
  confirm: that the DGXs can mount `nas.as267.com:/LLMs` once NFS host
  access is added, and that `stat` there prints `symbolic link`. (The
  NAS node's `/mnt/llms` turned out to be the QNAP's own ext4 volume
  folder, mounted directly, not NFS.)
- **Q2:** has `sync-local` from the store ever worked since Nov 9? If it
  did, something changed after that date (Samba upgrade or config,
  `vers=`), and fix 1 may be a rollback rather than a new setting.
- **Q3:** in fix 2, should a node with no inventory yet keep today's
  `sync`? Proposed default: yes, following the project's "absent = unknown"
  rule; the agent preflight still catches it.
- **Risk:** under POSIX extensions, the client may see different
  permissions and owners on the store. Check a `download-queue` and a
  `sync-local` after the change.

## Overlap findings

Jira search (`project = IR`, open, text matching sync-local, nasRoot, NAS
mount, or "active NAS reference") returned no issues. Related closed work:
IRI-005 (M4 mfsymlinks assumption), IRI-014 / ADR-0009 (NAS-first
downloads), IR-133 (resume transfer), IR-206 (store-read deadline), and
IR-100 (push preferred over sync).
