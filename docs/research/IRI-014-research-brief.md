# IRI-014 research brief — NAS-agent downloads + always-form-a-queue

- **Date:** 2026-10-20
- **Ticket:** IRI-014
- **Goal:** (1) Where do /models "Download from HF…" downloads execute today, and what
  does it take to run them on the NAS agent (owner rationale: the NAS is directly
  connected to the router at 10 Gb and is the store, so it should do the fetching)?
  (2) What happens today when a download is added — wait to form a queue, ask the user,
  or start immediately — and where should the owner requirement "always try to form a
  queue" live?

## 1. Where a download executes today

**Web target selection is "first online node with `nasRoot`, in list order"** —
`apps/web/src/components/ModelsView.vue:69-71`:

```ts
/** First online node whose agent can reach the NAS store (nasRoot set). */
const storeNode = computed(() => nodes.value.find((n) => n.online && n.nasRoot !== null)?.id ?? null);
```

No NAS-kind preference is applied. The submit handler posts a job to that node —
`ModelsView.vue:101-117`: `await createJob(nodeId, "download-queue", { downloads: [{ source, name }], jobs: downloadJobs.value })` →
`apps/web/src/models.ts:59-63` POSTs `/api/v1/nodes/:id/jobs`. The server does no role
lookup (`apps/server/src/app.ts:461-475`, comment: "Enqueue + dispatch a job to the
node's agent (one active per node)") and the hub pushes `nasRoot` to agents via
config-update (`apps/server/src/hub.ts:117-127`). The agent then spawns modelctl:
`apps/agent/src/modelctl.ts:111-124` builds a temp YAML and runs
`modelctl queue <tmp> --jobs N --root <nasRoot>` (spawn at `modelctl.ts:228-235`).

**Live fleet ground truth (hub 10.20.30.9:3947, deploy dev-0.3.0-dev.5, 2026-10-20):**
`GET /api/v1/nodes` returned, in list order:

| order | name | kind | role | online | nasRoot |
|---|---|---|---|---|---|
| 1 | DGX-1 | spark | head | true | `/mnt/nas` |
| 2 | DGX-2 | spark | worker | true | `/mnt/nas` |
| 3 | DGX-3 | spark | worker | true | `/mnt/nas` |
| 4 | NAS | nas | standalone | true | `/mnt/llms` |

So `storeNode` resolves to **DGX-1**: today every "Download from HF…" runs modelctl on
dgx1's agent and the bytes flow HF → router → dgx1 → `/mnt/nas` mount → NAS store. The
NAS agent is online with a local store root (`/mnt/llms`) but is never selected by the
Models page.

**The dgx1 route is the CIFS route.** modelctl's own runbook mounts the store on dgx-1
via SMB — `~/Developer/modelctl/smb-persistent-mount.md:62`:
`//nas.lan/llms /mnt/nas cifs credentials=…,mfsymlinks,_netdev,nofail,x-systemd.automount…`.
modelctl explicitly flags CIFS as a caveat —
`~/Developer/modelctl/src/modelctl/download_queue.py:186`: `" CIFS mounts commonly require the 'mfsymlinks' mount option."`
— and gates the root with a symlink probe (`download_queue.py:166-194`,
`validate_queue_root`: "Verify the store can create the atomic active references
downloads need"). Running modelctl on the NAS with a local root avoids CIFS entirely;
staging → published stays a same-filesystem rename
(`operations.py:316-320`, `assert_same_filesystem(staging, final)`).

**In-repo precedent already prefers the NAS kind.** `apps/server/src/setups-service.ts:656-659`:

```ts
const nasNode = allNodes.find((n) => n.kind === "nas" && n.nasRoot !== null && n.enabled)
  ?? allNodes.find((n) => n.nasRoot !== null && n.enabled) ?? null;
```

The Models page does not reuse this preference — that is the gap.

**Architecture constraints.** ADR-0004 (`docs/adr/0004-modelctl-as-supply-chain-engine.md`)
requires modelctl on model-ops nodes (NAS + Sparks) and rejects serving model ops from
the server container: "routes multi-GB transfers through the server host and assumes the
server can reach the NAS/NFS — wrong place for the work" (:57-58). So the fix is
node-selection, not moving the work into the server.

## 2. What happens today when a download is added (queue? prompt? start?)

**It just starts — one model per submit, no prompt, no persistent queue.**

- Single-model modal only, three fields (HF repo, store name, parallel jobs 1–16):
  `ModelsView.vue:359-390`; footer "Resumable · preflighted · companion files included";
  submit button `{{ downloadBusy ? "Queueing…" : "Queue download" }}` (:388). The label
  says "Queue" but nothing is enqueued.
- Submit → immediate job creation; the modal closes and the job drawer opens
  (`ModelsView.vue:101-117`, drawer at :340-355, 2 s polling at :190-202).
- If the store node already has **any** active job, the second download is rejected:
  `apps/server/src/jobs-service.ts:134-160` — `if (active) throw new JobBusyError("node
  already has an active job (${active.id})")` (409). The constraint is node-scoped and
  kind-agnostic (a running download also blocks sync/push/hygiene jobs on that node);
  the agent enforces the same rule (`apps/agent/src/jobs.ts:52-56`: "One active job per
  node (SPEC §13)"). The row's `queued` status lasts only the instant before dispatch;
  there is no server-side pending queue.
- So today: add 1 download while idle → starts immediately; add another while one runs →
  409 error surfaced in the modal (`models.ts:59-63` docstring: "409/404 surface as
  errors with the server message").

## 3. modelctl queue semantics (what a wrapper can rely on)

- **A "queue" is a YAML file read at invocation — no persistent state, no daemon.**
  `~/Developer/modelctl/src/modelctl/download_queue.py:80-83` (`load_download_queue`:
  "Load and strictly validate the local YAML queue structure");
  `cli.py:1426-1447` dispatch: load → `validate_queue_root` →
  `prepare_download_queue` → `validate_prepared_manifests` → print
  `"preflight complete: starting {n} download(s), up to {c} concurrent"` →
  `execute_download_queue`. Queue YAML: `downloads` top-level mapping with a non-empty
  list (`README.md:241-242`; example `downloads.yaml`).
- **Preflight-all-then-start:** "Validate every remote selection before any model
  download starts" (`download_queue.py:204`); "If any preflight check fails, the command
  exits before writing manifests or downloading model data" (`README.md:347-352`).
- **Concurrency:** `ThreadPoolExecutor(max_workers=min(jobs, len(prepared)))`
  (`download_queue.py:323-325`); `--jobs` defaults to 1 (`cli.py:794-798`) — the iroiri
  modal passes 4 (`ModelsView.vue:37`). Per-model `fcntl.flock` prevents double
  activation (`layout.py:80-90`, used at `operations.py:258`).
- **Failure handling:** per-entry failures don't stop the batch
  (`download_queue.py:311-313`); the command prints every result and exits 1 if any
  entry failed (`cli.py:1471-1477`). "Interrupted entries retain resumable staging data.
  Rerunning the queue reuses valid published objects and resumes incomplete downloads"
  (`README.md:342-345`; reuse path `operations.py:264-277`, resume path
  `operations.py:288-292`).
- **Output shapes:** `download` has no `--json` — two summary lines only
  (`cli.py:1404-1407`: `manifest: …` / `active: …`). `queue` emits structured progress
  lines: `preflight: …` (:1429), `[i/n] ready: {name} <- {source} ({selection})`
  (:1436-1441), `[i/n] complete: {label} -> {result.active_path}` (:1451-1455),
  `[i/n] failed: {label}: {type}: {error}` on stderr (:1456-1466). Per-file progress is
  huggingface_hub's stderr tqdm; modelctl adds no progress callbacks for downloads.
- **No remote execution mode:** no server/API/daemon in `src/`; the unimplemented
  `plans/central-cluster-model-management.md` is a plan only. modelctl runs wherever the
  store path is mounted — the NAS host itself is just another POSIX host with a local
  root (`/mnt/llms` via the NAS agent's `nasRoot`).

## 4. Where the "always try to form a queue" can live

| Option | Mechanism | Tradeoffs |
|---|---|---|
| A. Server-side pending download queue (DB) | New `download_queue` rows (source, name, status, jobId). Add → insert pending; when the store node is idle, dispatch **all pending entries as one `download-queue` batch** (existing job kind, existing YAML path). On terminal batch status, reconcile and dispatch next batch. | Durable across server restarts (jobs live in `jobs` + `job_output`, `jobs-service.ts:171-186`); keeps the one-active-per-node job contract (ADR-0003) intact — only one modelctl invocation at a time; queue list/reorder/cancel is plain DB + UI work; modelctl gets one preflighted batch with its own `--jobs` concurrency. Cost: new table + migration, dispatch/reconcile logic, boot-time reconcile. |
| B. Multi-model modal only | Modal accepts N models → single job on submit. | Tiny change; but queue dies with the page, still 409s if a job is running, and doesn't satisfy "always form a queue". |
| C. modelctl-native persistent queue | Would require a daemon/queue file in modelctl. | Doesn't exist today (§3: invocation-scoped YAML only); means Python changes in a second repo; ADR-0004 keeps iroiri out of store internals but this would grow modelctl for an iroiri-only need. Rejected. |
| D. Agent-side queue | Agent accepts multiple queued jobs. | Agent job state is in-memory only (`apps/agent/src/jobs.ts:60-68`) — queue lost on agent restart; weakens the one-active-per-node contract. Rejected. |

**Failed-batch reconciliation detail (applies to A):** modelctl exits 1 if any entry in
a batch failed, but other entries still publish. Options to learn which entries
succeeded: parse `[i/n] complete:` output lines (ADR-0004 already warns CLI-text
parsing is best-effort) vs reconcile requested names against the store catalog after
the job's `catalog-request` refresh (`jobs-service.ts:272-276` already sends it;
`onCatalog` upserts `model_meta`, `jobs-service.ts:289-302`). Catalog reconciliation is
authoritative and uses an existing flow.

## 5. Download execution placement options

| Option | Behavior | Tradeoffs |
|---|---|---|
| A. NAS-preferred (mirror `setups-service.ts:656-659`) | Pick `kind === "nas" && nasRoot && enabled && online` first; fall back to any online `nasRoot` node when no NAS-kind node is online. | Matches an existing codebase convention; keeps downloads available when the NAS agent is briefly down (degraded: bytes cross the CIFS mount again); one-line selection change + tests. |
| B. NAS-only | Downloads require the NAS-kind node online, else error. | Purest placement, but models page download becomes fully blocked by one agent's downtime even though a mounted fallback exists. |
| C. Status quo (first `nasRoot` in list order) | — | Verified wrong for this fleet (DGX-1 selected). Rejected. |

**Verification prerequisite (not yet evidence):** the NAS agent must have modelctl ≥ pin
installed (ADR-0004 install/upgrade job; `doctor`) and outbound access to
huggingface.co. If either fails, downloads on the NAS must fail loudly before any
staging writes — modelctl's `validate_queue_root` + preflight already provide the loud
failure, but presence/egress should be checked live during implementation.

## Summary of Findings

1. **Where downloads run today:** on an agent — but the wrong one. The /models page
   picks the first online node with `nasRoot` in list order; in the live fleet that is
   DGX-1 (head) with the `/mnt/nas` CIFS mount, not the NAS agent (`/mnt/llms`, online,
   kind `nas`). Evidence: `ModelsView.vue:69-71` + live `GET /api/v1/nodes` table (§1).
   Fix: NAS-preferred selection mirroring `setups-service.ts:656-659` (recommended),
   with fallback to other `nasRoot` nodes when no NAS-kind node is online.
2. **What happens when a download is added:** it starts immediately — single-model
   form, no prompt about one-or-more, no persistent queue; a second add while any job
   runs on that node gets a 409. Evidence: §2.
3. **modelctl cannot host the queue:** its queue is a YAML file processed within one
   invocation (preflight-all → ThreadPool → exit), no daemon/persistent state (§3).
   The "always form a queue" requirement therefore belongs **server-side**: DB-backed
   pending queue, dispatching pending entries as one `download-queue` batch on the
   store node when it is idle (Option A, §4), with catalog-based failure
   reconciliation.
4. **Open items:** (a) verify modelctl presence + HF egress on the NAS agent live;
   (b) owner confirmation of fallback placement when the NAS agent is offline —
   recommendation: mirror setups fallback; (c) pending-queue UI affordances
   (list/remove/retry) scoped during implementation.
