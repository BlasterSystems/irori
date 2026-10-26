# IRI-028 research brief — per-node models, deletion, hygiene detail, job activity

- **Date:** 2026-10-26
- **Ticket:** IRI-028
- **Goal:** Four owner questions about the live fleet, each blocking a
  decision-complete implementation:
  1. What models actually exist on a node, where do they live, and how can the
     node detail page list and delete them?
  2. Why did deleting `glm-5.3-500b-exl3-3.0bpw` fail with
     `[Errno 13] Permission denied: 'CACHEDIR.TAG'`, what state is the store
     in now, and what can recover it?
  3. What can the disk-hygiene audit say per category about what would be
     deleted and how much it saves, and is the dry-run plan step still needed?
  4. Why does leaving the Models modal lose a running job's log, and where
     should that activity live?

## 1. What "models on a node" means on this fleet

Three independent storage classes exist; they are not interchangeable and they
do not share names.

| Class | Location | Source of truth | Delete verb | Size available? |
|---|---|---|---|---|
| Store (NAS source of truth) | NAS node `nasRoot=/mnt/llms`; sparks mount `/mnt/nas` (CIFS) | `catalog.json` schema 3 or live `active/` scan | `modelctl delete NAME --apply --yes` | yes (`bytes` in catalog/list) |
| Local modelctl registration | per-user HF cache (`<home>/.cache/huggingface/hub`) + per-user state (`<home>/.local/state/modelctl/hf-cache/<hash>/active/NAME.json`) | `modelctl list --local` as that user | `modelctl delete-local NAME` as that user | no (`list --local --json` omits bytes) |
| Unregistered HF-cache data | same cache dirs, not in any registration | `refs/` reachability (`scanHfCache`) | disk-hygiene `hf-cache` category | yes (walk) |

Evidence for the local class being **per user**, not per node:

- `modelctl` keys its local registration state off the invoking user's home:
  `~/Developer/modelctl/src/modelctl/hf_cache.py:61-74`:
  ```python
  def _state_base() -> Path:
      selected = os.environ.get("XDG_STATE_HOME")
      return Path(selected).expanduser() if selected else Path.home() / ".local" / "state"

  def state_root(cache_dir: Path) -> Path:
      cache = canonical_cache(cache_dir)
      identity = hashlib.sha256(os.fsencode(cache)).hexdigest()[:20]
      return _state_base() / "modelctl" / "hf-cache" / identity
  ```
  Passing `--cache-dir /home/operator/.cache/huggingface/hub` while running
  as root still reads **root's** state dir, so another user's registrations
  are invisible to `modelctl list --local` run as root.
- Live, on DGX-1 (2026-10-26):
  ```
  $ ~/.local/bin/modelctl --version
  modelctl 0.20.1
  $ ~/.local/bin/modelctl list --local --json
  [
    { "name": "glm-5.3-flash-dflash2", "runtime": "vllm", "repository": "incoai/GLM-5.3-Flash-DFlash2" },
    { "name": "glm-5.3-flash-tr3-4bpw", "runtime": "vllm", "repository": "brandonmusic/GLM-5.3-Flash-tr3-4bpw" }
  ]
  ```
  The binary is `~/.local/bin/modelctl -> ~/.local/share/uv/tools/modelctl/bin/modelctl`
  (per-user uv tool install).
- The agent runs as **root** (`docs/ADR-0003`, `apps/agent/irori-agent.service`),
  so its `modelctl path --local` sees root's cache only. The live setup
  `glm-5.3-flash-exl3-q4` is stopped with
  `lastError: "MODEL_PATH resolution failed for glm-5.3-flash-exl3-q4 (modelctl path --local)"`
  (`GET /api/v1/setups`, 2026-10-26) — the model exists only in the user's cache.
- `list --local --json` carries **no bytes**: `~/Developer/modelctl/src/modelctl/cli.py:231-240`
  emits `{name, runtime, repository}` only, and `list_cached_models` sets
  `size_bytes=0` (`operations.py:857-874`). A size needs either a modelctl
  field or an agent-side `du` of the snapshot root.

Store-side listings do carry sizes: `_active_model_record` measures the object
dir (`operations.py:395-412`), and `catalog.json`/`list --json` project
`{name, runtime, repository, bytes}` (`cli.py:179-232`).

Live store inventory (2026-10-26): `GET /api/v1/models?page=1` → `total: 148`;
`/mnt/llms/active` has 148 entries. `GET /api/v1/nodes/<NAS>/snapshot`:

```json
"storage": [
  { "mount": "/",        "fs": "ext4", "totalBytes": 21171355648,    "usedBytes": 4841541632 },
  { "mount": "/mnt/nas", "fs": "ext4", "totalBytes": 18108599115776, "usedBytes": 14195572305920 },
  { "mount": "/mnt/llms","fs": "cifs", "totalBytes": 18108599115776, "usedBytes": 14196125954048 }
]
```

So the NAS agent operates the store through a **CIFS mount of its own share**
(`/mnt/llms`), while the same bytes are available locally at `/mnt/nas`
(ext4). That distinction becomes decisive in §3.

## 2. Why the Models page says "sync" for models that are already on the spark

`node_models` is **not** an inventory; it is a side effect of job completions:

- `apps/server/src/jobs-service.ts:263-276` inserts a row only when a
  `sync-local`/`download`/`push` job **succeeded**, and deletes rows only on a
  succeeded `delete-local`/`nas-delete-apply`.
- Placement reads it by model **name**: `presentNodesFor(name)`
  (`jobs-service.ts:321-325`) and the planner in `app.ts:824-863`.

Two independent reasons it lies for the owner's case:

1. Models downloaded manually (the owner's `modelctl` runs as `operator`)
   never produced a job, so no `node_models` row exists.
2. Local registration names are chosen at download time and need not match the
   store name. Live example: store `GLM-5.3-Flash-EXL3-4bpw`
   (`brandonmusic/GLM-5.3-Flash-EXL3-4bpw`) vs local
   `glm-5.3-flash-tr3-4bpw` (`brandonmusic/GLM-5.3-Flash-tr3-4bpw`).
   A name-keyed inventory cannot equate them even when both exist.

Live placement for a store model the owner has on every spark:

```json
{ "model": { "name": "GLM-5.3-Flash-EXL3-4bpw", "bytes": 175716732928 },
  "placements": [
    { "node": { "name": "DGX-1" }, "action": "sync" },
    { "node": { "name": "DGX-2" }, "action": "sync" },
    { "node": { "name": "DGX-3" }, "action": "sync" },
    { "node": { "name": "NAS" },   "action": "present" } ] }
```

(The owner's screenshot of the same drawer shows the same three `SYNC FROM NAS`
rows.) The node detail page must therefore list **what the agent can actually
see per storage class**, with the owner (user) attached to local entries —
not join on names.

## 3. The failed delete: evidence, mechanism, recovery

### 3.1 What happened

`GET /mnt/nas/state/glm-5.3-500b-exl3-3.0bpw.delete.json` (read from DGX-1's
CIFS mount, 2026-10-26):

```json
{ "operation": "delete", "state": "FAILED",
  "history": [
    { "state": "PLANNED", "at": "2026-10-26T05:28:58Z",
      "reference": "/mnt/llms/active/glm-5.3-500b-exl3-3.0bpw",
      "object": "/mnt/llms/models/0xSero/GLM-5.3-500B-EXL3-3.0bpw/bada39f0ae0d6d9c7e3f8c14d368a5bacf5d5401--709910c6b85b",
      "repo": "0xSero/GLM-5.3-500B-EXL3-3.0bpw", "staging": 0, "objects": 1 },
    { "state": "REFERENCE_REMOVED", "at": "2026-10-26T05:28:58Z", ... },
    { "state": "CATALOG_REFRESHED", "at": "2026-10-26T05:29:00Z" },
    { "state": "STAGING_REMOVED",   "at": "2026-10-26T05:29:14Z", "removed": 0, "retained": 0 },
    { "state": "FAILED", "at": "2026-10-26T05:29:27Z",
      "object": ".../bada39f0...--709910c6b85b",
      "error": "PermissionError: [Errno 13] Permission denied: 'CACHEDIR.TAG'" } ] }
```

The model is **deactivated** (no `active/glm-5.3-500b-exl3-3.0bpw`) and its
~197 GB object is orphaned. The object is still present:

```
$ ls -la /mnt/nas/models/0xSero/GLM-5.3-500B-EXL3-3.0bpw/bada...--709910c6b85b | head -4
drwxr-xr-x ... .
-rwxr-xr-x ... chat_template.jinja
-rwxr-xr-x ... config.json
...
$ ls -la .../.cache/huggingface
-rwxr-xr-x ... CACHEDIR.TAG
drwxr-xr-x ... download
```

`CACHEDIR.TAG` is written by `huggingface_hub` into `<local_dir>/.cache/huggingface`
(`.venv/lib/python3.12/site-packages/huggingface_hub/_local_folder.py:429-469`),
i.e. it is a normal file inside the object, not a modelctl artifact.

### 3.2 Why the name is bare

`shutil.rmtree` on Linux uses `_rmtree_safe_fd`, which unlinks with
`os.unlink(entry.name, dir_fd=...)`; the `OSError.filename` is therefore the
bare entry name, not the full path. The error is a **directory write denial**,
not a file-mode problem. Reproduced locally (macOS, non-root, dir mode 0555):

```
$ python3 - <<'PY'
import os, shutil, tempfile
d = tempfile.mkdtemp(); open(os.path.join(d, "CACHEDIR.TAG"), "w").close()
os.chmod(d, 0o555)
try: shutil.rmtree(d)
except OSError as e: print(repr(e), "filename=", e.filename)
PY
PermissionError(13, 'Permission denied') filename= CACHEDIR.TAG
```

### 3.3 Which directories deny writes (measured)

CIFS mount on DGX-1 (`mount | grep /mnt/nas`):

```
//nas.lan/llms on /mnt/nas type cifs (rw,relatime,vers=3.1.1,
username=operator,uid=1000,forceuid,gid=1000,forcegid,file_mode=0755,
dir_mode=0755,mfsymlinks,soft,nounix,mapposix,...)
```

`stat` shows `1000 1000 755` everywhere because CIFS fakes ownership; the
server-side ACL is what matters. Probe (create + unlink a temp file, DGX-1 as
`operator`, 2026-10-26):

```
DENIED   /mnt/nas/models/0xSero/GLM-5.3-500B-EXL3-3.0bpw/bada...--709910c6b85b
DENIED   /mnt/nas/models/0xSero/GLM-5.3-500B-EXL3-3.0bpw
WRITABLE /mnt/nas/models/0xSero
WRITABLE /mnt/nas/models
WRITABLE /mnt/nas/active
WRITABLE /mnt/nas/state
```

Both the repository dir and the object dir (and `.cache/huggingface` inside it)
deny writes; everything above them is writable. The NAS agent got exactly as
far as `active/` + `catalog.json` and then hit the denied object tree. This is
a per-directory SMB ACL/ownership mismatch (the object was created 2026-09-08,
before the agent existed), not a read-only mount and not a file mode.

### 3.4 The recovery advice in the error is wrong for this failure

The message says the data "remains recoverable with `modelctl objects-audit`
and `modelctl gc-objects`" (`operations.py:715-726`), but `gc-objects` calls
the same `shutil.rmtree(path)` (`maintenance.py:246-274`) as the failing
delete, so it fails identically under the same ACLs. A retry of
`modelctl delete NAME` also cannot work: the active reference is already gone,
so `_validate_delete_target` raises "has no active reference".

### 3.5 Options

| Option | Change | Tradeoff |
|---|---|---|
| **A. modelctl preflight + actionable error (recommended)** | Before `reference.unlink()`, probe every directory of each object/staging tree to be removed (create+unlink a temp file); abort **before deactivation** with the failing path, errno and remediation. Reuse the same wrapper in `gc-objects`/`cleanup-staging`. | No half-deleted store; the user keeps a working model instead of an orphan. Cannot bypass ACLs — the fix is still ownership/permissions. Patch release + pin bump. |
| B. chmod-retry inside rmtree | On `PermissionError`, `chmod u+rwX` the tree and retry. | Helps only when the process owns the tree. In the observed case the principal does not own it, so it fails again; masks the real cause. |
| C. Admin-only fix (no code) | Fix ownership/ACLs on the NAS, delete the orphan by hand. | Recovers this model, but the next pre-agent model fails the same way after deactivation. |

Recommended: **A**, plus the one-time admin recovery in §3.6.

### 3.6 Recovering this object (owner action)

The current agent cannot delete it from any node (DGX-1's CIFS principal is
denied too, probed above). In order of preference:

1. On the NAS itself (root/admin), fix the tree and delete it via the local
   ext4 mount — the same bytes as `/mnt/llms`, but POSIX permissions instead
   of the SMB ACL:
   ```sh
   chown -R <store-owner>:<store-group> /share/llms/models/0xSero/GLM-5.3-500B-EXL3-3.0bpw
   modelctl gc-objects 0xSero/GLM-5.3-500B-EXL3-3.0bpw/bada39f0ae0d6d9c7e3f8c14d368a5bacf5d5401--709910c6b85b --apply --root /mnt/nas
   ```
   (`gc-objects` takes exactly the three-part path relative to `models/`,
   `maintenance.py:135-152`; modelctl ≥ 0.21.1 tolerates journals written
   under a foreign mount point.)
2. Or reset the folder's permissions/ACLs from the NAS UI (QNAP File Station
   "Reset permissions" / `smbcacls`) so the agent's SMB principal can write.
3. Or point the NAS node's `nasRoot` at `/mnt/nas` (local ext4) and retry —
   this also removes a CIFS hop from every download/delete on the store node.

Open: the NAS's SMB principal and the object's real owner cannot be read from
this workstation (SSH to the NAS is key-denied for `operator`, `admin`,
`root`). Measure with `getfacl`/`smbcacls` on the NAS, or `ssh <admin>` and
`ls -ln /share/llms/models/0xSero/...`.

## 4. Disk hygiene: what the audit can detail, and the dry-run step

### 4.1 Current contract

`packages/core/src/hygiene.ts:44-62` — each category carries
`{category, safe, rationale, itemCount, reclaimableBytes}`; the report carries
`{generatedAtMs, totalBytes, freeBytes, categories}`. The agent computes those
from concrete sources (`apps/agent/src/hygiene.ts:278-470`):

| Category | Source / target | Detail the audit already has |
|---|---|---|
| docker-build-cache | `docker system df` Build Cache reclaimable | bytes only |
| docker-images | `docker images` minus last 2/repo minus protected | per-image rows in memory (repo:tag, size, created) — **not exposed** |
| docker-containers | `docker ps -aq --filter status=exited/created` + df reclaimable | count + bytes |
| hf-cache | `scanHfCache` (`hygiene.ts:161-200`): `blobs/*.incomplete` + snapshots no `refs/*` points at | split bytes/counts in memory — **not exposed** |
| modelctl-staging | `modelctl staging-audit --json`, non-resumable only | per-entry path/status/bytes in memory — **not exposed** |
| compiler-caches | `~/.cache/{vllm,torch,triton}`, `~/.nv/ComputeCache` | per-dir bytes in memory — **not exposed** |
| apt-caches | `/var/cache/apt` walk | bytes only |
| system-junk | `journalctl --disk-usage`, `/tmp` > 7 d, core dirs | journal/tmp/cores aggregated — **not exposed** |

So the drawer can already show more without new privileged commands: the
agent must retain and emit the per-target rows it already computes.

### 4.2 The dry-run step

`CleanupDrawer.vue` currently runs `hygiene-clean {dryRun:true}` ("Plan clean
(dry run)"), renders the plan table, then arms a typed node-name confirm and
runs `{dryRun:false}`. `cleanHygiene` honors `dryRun` by skipping the child
commands (`hygiene.ts:475-520`) — it is a *plan* of the same selected
categories, not an independent safety check. Removing the CTA keeps the typed
confirm and the streamed per-category outcome table; the audit report (with
details) becomes the plan. The `dryRun` param can stay in the contract for
tests/back-compat.

## 5. Job activity: where the log goes when the modal closes

- Job output is persisted server-side: `job_output` ring, last
  `MAX_OUTPUT_LINES = 400` lines (`jobs-service.ts:38-40, 228-238`), fetchable
  via `GET /api/v1/jobs/:id`.
- SSE carries only **terminal** job frames:
  `jobEventSchema.status = ["succeeded","failed","canceled"]`
  (`packages/core/src/events.ts:93-101`), emitted by `onSettled`
  (`apps/server/src/index.ts:206-211`). No start frame, no output frames.
- The Models page's job drawer is local component state (`ModelsView.vue`
  `job`/`jobPoll`); leaving the page/modal drops the view while the job keeps
  running. There is no jobs list endpoint (`app.ts` exposes only
  `GET /api/v1/jobs/:id` + cancel).

The owner's report ("started a NAS→DGX1 download, left the modal, no way to
know what is going on") is exactly this gap. Options:

| Option | Change | Tradeoff |
|---|---|---|
| **A. Global Activity drawer + SSE start/progress (recommended)** | `GET /api/v1/jobs?limit=` (all nodes, last line included); extend the `job` event with `running`; add a throttled `job-progress` event (≤1/s per job) from the existing `onOutput` path; App-level drawer reachable from the topbar, active count badge, per-job output tail, cancel. | One new surface + two additive events; the log survives navigation and is available on every page. SSE volume bounded by the 1/s throttle. |
| B. Put progress lines in the Overview Telemetry feed only | `feedLines` renders progress | The feed is a 30-line tail; 1/s progress evicts every other event. Bad fit. |
| C. Per-node Jobs section | `GET /api/v1/nodes/:id/jobs` + section on NodeDetail | Still requires navigating to the node; the global question stays unanswered. |

Recommended: **A**, with job start/settle lines in the Telemetry feed and the
live output in the Activity drawer.

## 6. Data path for the node inventory

| Option | Shape | Tradeoff |
|---|---|---|
| **A. Read-only agent job `models-inventory` + server cache (recommended)** | Agent builds `{store, local[]}` (store catalog + failed-delete journals + per-user `list --local`), emits JSON as the final output line; hub persists it in `node_inventory`; `GET /api/v1/nodes/:id/models`; `POST …/models/refresh` dispatches the job. | Mirrors the proven `hygiene-audit` pattern (one-active-per-node, final-line JSON, schema-validated). Consumes the node's single job slot briefly; needs an agent release. |
| B. New `inventory-request`/`inventory` WS frames | Like `catalog-request` | No job slot, but a second fire-and-forget protocol path with no failure surface; more surface for the same data. |
| C. Server reads the store / SSH | Server container has no store mount (ADR-0004) | Rejected by the architecture. |

Per-user local listing must run `modelctl` **as the owning user** (root agent →
`runuser -u <user>`), because state is per-user (§1). Discovery: `/etc/passwd`
homes with `<home>/.cache/huggingface` and an executable
`<home>/.local/bin/modelctl`; root runs directly. Deletes use the same wrapper
with a validated `{name, user}` (binary and home derived agent-side, never from
the request).

## Summary of Findings

1. **Node models:** three classes (store, per-user local registration,
   unregistered HF data). The store list is `modelctl list --json --root` /
   `catalog.json` (sizes present). Local registrations are per **user**, not
   per node, and `list --local --json` has no sizes — the agent must run it as
   each cache owner and can measure the snapshot dir for bytes. `node_models`
   is job-derived and name-keyed, so it cannot answer this and must not be
   used as the inventory.
2. **Delete failure:** the NAS agent operates the store through a CIFS mount
   (`/mnt/llms`) and the object's repo/object dirs deny writes to that SMB
   principal (probed from DGX-1 too). modelctl deactivates first and then
   fails, leaving an orphan; `gc-objects` fails identically. Fix: modelctl
   preflight before deactivation + actionable error (option A), and a one-time
   admin/ACL recovery for this object (the local `/mnt/nas` ext4 path is the
   best route). The exact SMB owner is not readable from here — open item.
3. **Hygiene:** the audit already computes per-target rows (old images, HF
   incomplete/unreferenced split, staging entries, compiler dirs, journal/tmp/
   cores); exposing them needs an additive `details` array, no new privileged
   commands. The dry-run step is a repeat of the same selected-category plan;
   removing the CTA keeps the typed confirm and the real outcome table.
4. **Job activity:** output is persisted but only terminal frames are on SSE,
   and the job drawer is component-local. A global Activity drawer fed by a
   jobs list endpoint + `job` (running) + throttled `job-progress` events
   answers the owner's case without flooding the Telemetry feed.

### Open items

- NAS SMB principal / object owner (needs NAS-side `getfacl`/`smbcacls`).
- Whether the NAS agent (root) can delete through `/mnt/nas` (ext4) — measure
  by switching `nasRoot` or running `gc-objects --root /mnt/nas` as root.
- Whether local-model sizes should come from a modelctl `list --local` `bytes`
  field (cleaner) or an agent-side snapshot walk (no release dependency);
  recommendation: agent-side walk first, modelctl field optional later.
- The placement planner's name-keyed `present` semantics remain wrong for
  renamed local copies; out of scope here (reported as a follow-up).
