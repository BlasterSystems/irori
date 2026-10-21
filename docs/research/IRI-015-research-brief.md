# IRI-015 research brief — bulk "add downloads" UX + queue ownership

- **Date:** 2026-10-20
- **Ticket:** IRI-015 (open decision — no implementation yet; ADR-0009 revisit trigger)
- **Goal:** The owner wants the /models "Download from HF" popup to accept **all** the
  downloads they want in one go, run through the modelctl queue. Alternative on the
  table: change modelctl itself (owner-owned tool). This brief lays out the options
  with evidence and tradeoffs so the owner can make the final call.

## 1. What exists today (evidence)

**Modal is single-entry and closes after every add** — `apps/web/src/components/ModelsView.vue:470-499`:
one HF-repo field, optional store name, parallel jobs 1–16, `Add to queue` →
`enqueueDownload({source, name, jobs})` → modal closes, fields cleared
(`ModelsView.vue:113-133`). Adding 5 models today means reopening the modal 5 times,
and each add dispatches **immediately as its own batch** while the node is idle.

**Server queue already forms ONE batch from all pending rows when the store node is
idle** — `apps/server/src/download-queue-service.ts:83-118` (`dispatchIfIdle` selects
ALL `pending` rows, one `download-queue` job with `downloads: rows.map(...)`, `jobs` =
max across entries). Adds made **during** a running batch stay `pending` and drain on
settle (`onJobSettled` → `dispatchIfIdle`) — so consecutive single adds form serial
one-entry batches, never parallel across models (one-active-per-node, ADR-0003).

**modelctl's queue is invocation-scoped YAML** — `~/Developer/modelctl/src/modelctl/download_queue.py:80-83`
(`load_download_queue`: "Load and strictly validate the local YAML queue structure");
`cli.py:1426-1447` (load → preflight-all → `execute_download_queue`). No daemon, no
persistent state, no "queue add" verb. Preflight validates every entry remotely
**before** any download starts (`download_queue.py:204`, `README.md:347-352`), then a
`ThreadPoolExecutor` runs `min(--jobs, len)` entries concurrently
(`download_queue.py:323-325`); failures continue, exit 1 if any entry failed
(`cli.py:1471-1477`).

**The agent's YAML builder already accepts arbitrary per-entry fields** —
`apps/agent/src/modelctl.ts:36-58` (`buildQueueYaml`: `source`, `name`, `revision`,
`quantization`, `runtime`, `mmproj`, `mtp`, `force`). Irori's UI/server currently
passes only `source`/`name` (core `downloadCreateSchema`); the agent needs **no
change** for multi-entry batches.

**modelctl has no latent queue/daemon machinery.** The repo's only forward-looking
plan is `plans/central-cluster-model-management.md` — central **placement** control
(`cluster sync/inventory/remove` over SSH-rsync), which is a different concern (Irori
already covers placement via agents); it mentions no queue daemon. `sync-local
--queue models.txt` (README.md:478-494) is a plain-text list for syncing, not a
persistent download queue.

**Throughput note:** with the NAS on a 10 Gb router link, one model download typically
saturates a large share of the bandwidth (modelctl downloads via
`huggingface_hub.snapshot_download`, `hub.py:56-71` — default chunked transport, no
`hf_transfer`). Cross-model parallelism helps only when a single model's stream is
the bottleneck; serial batches are close to bandwidth-optimal. The main cost of
serial one-entry batches is one extra preflight round per add (seconds), not wasted
bandwidth.

## 2. What "add all at once" requires

The **server-side queue (ADR-0009) already is the batching mechanism**: entries added
while the node is idle all land in one preflighted modelctl invocation. What's missing
is only the **input UX** (N entries per submission) and, optionally, **coalescing** of
adds that trickle in while a batch is running. Changing modelctl is not *required* for
the stated goal — but three modelctl-side options exist and are evaluated below.

## 3. Options

### Option A — Multi-entry modal (web-only)

The popup accepts N downloads in one submission; server queues them all; when the node
is idle they run as **one modelctl queue batch** (existing dispatch path, zero backend
change).

UI variants (can combine):

| Variant | UX | Cost |
|---|---|---|
| A1: multi-line paste | One textarea — one `owner/model` per line (matches HF id lists); names auto-derived (`deriveDownloadName`) | Smallest; best for bulk adds |
| A2: repeatable rows | `+ add row` button; per-row source + optional name | Per-entry control; more UI state |
| A3: keep-open loop | Modal stays open after each add with a toast + running queue list beneath | Trivial; today's flow minus the close |

Server shape: one batch `POST /api/v1/downloads {downloads: [{source, name?, jobs?}, …]}`
(atomic insert + single dispatch; per-entry 400 errors listed) — or keep N POSTs from
the client (works today, no server change at all).

- **Pros:** satisfies the stated goal exactly; zero modelctl change; no ADR revision;
  smallest blast radius; ships fast.
- **Cons:** adds made one-by-one (browsing pattern) still form serial one-entry
  batches (each waits for the previous batch to finish — no parallelism across
  models); per-batch preflight repeats.

### Option B — A + server-side coalescing (debounce)

Adds accumulate for a window (e.g. 30–60 s since the last add, or "dispatch after N
seconds of quiet") before the batch is formed; adds during a running batch join the
**next** batch together.

- **Pros:** sequential browsing-adds merge into fewer, parallel-capable batches; fewer
  preflight rounds; smooths the mid-batch-add experience.
- **Cons:** dispatch is no longer immediate (a 30–60 s delay before the first byte —
  visible in the UI as "queued (dispatching in 30s)"); needs timer state + boot
  reconcile (window lost on restart → immediate dispatch, acceptable); ADR-0009
  dispatch semantics need an amendment; more test surface (window edge cases,
  reaper-tick interaction).
- **Reality check:** bandwidth-wise the win is modest (§1 throughput note); the
  experience win is "I don't have to think about batching".

### Option C — A + modelctl `queue --json` (structured results)

Small modelctl change: the `queue` command gains `--json`, emitting one machine-readable
record per entry (`{index, name, source, status, active_path, error, durationMs}`) in
addition to (or instead of) the human lines (`cli.py:1451-1466` is where results are
printed). Irori's failed-batch reconcile (`download-queue-service.ts:settleBatch`)
switches from regex-parsing the output ring to reading the structured tail. Contract
convention already exists: `AGENTS.md:54-56` — "`--json` output must remain
machine-readable"; `download` currently has **no** `--json` (`cli.py:708-751`).

- **Pros:** closes ADR-0009's listed risk ("output-line parsing drift across modelctl
  versions"); removes the only fragile string-contract in the pipeline; trivially
  testable in modelctl (golden fixtures); pairs with any of A/B.
- **Cons:** modelctl change + version-pin bump + agent golden-output tests; a server
  fallback should stay for older pinned versions (parse lines if no JSON tail).

### Option D — modelctl-native persistent queue

modelctl owns the queue as **state on the store root**: `queue add` appends an entry
(client-stamped `--id`) under `ROOT/.modelctl-queue/pending/`, `queue list --json`
reports status, `queue run --jobs N` processes all pending atomically (journals +
moves to done/failed). Two trigger variants:

- **D1 (Irori-driven):** Irori keeps its Postgres rows and dispatches `queue run` as
  the batch job (today's job model, ADR-0003 untouched). Adds during a running batch
  append to pending files. Two sources of truth (server rows ↔ queue files) must be
  reconciled by the stamped id.
- **D2 (node-autonomous):** a systemd timer on the NAS agent runs `modelctl queue run`
  every minute — the queue processes even while Irori's server is down; Irori becomes
  a **view** (`queue list --json`) + job-frame tail for streaming.

- **Pros:** queue survives server *and* agent restarts (files on the store root —
  ADR-0004-compatible: modelctl writes only through its own commands); native CLI
  visibility into pending work; D2 decouples processing from the server entirely.
- **Cons:** largest change by far — new modelctl command surface + state layout +
  atomicity/locking (per-entry locks already exist per model, `layout.py:80-90`) +
  version pin + golden tests; **dual-state reconciliation** in Irori (Postgres rows ↔
  files, driven by stamped ids); ADR-0004/0009 boundary revisions; D2 additionally
  changes deployment (systemd unit on model-ops nodes) and weakens the one-active-
  per-node job framing (a timer running outside Irori's job system can race hygiene
  jobs on the same node).
- **When it's worth it:** only if node-level durability becomes a real requirement
  (long server/DB outages with the fleet still serving), or if the owner wants queue
  visibility native to modelctl for CLI-driven workflows.

### Option E — rejected alternatives

- modelctl `cluster` plan (SSH central placement): orthogonal to downloads; Irori's
  agents already implement placement locally.
- Server-side debounce alone without the multi-entry modal (B minus A): fixes
  trickle-adds but not the stated "add all at once" goal.

## 4. Recommendation

**A + C, B deferred, D rejected for now** (rationale):

1. A alone delivers the owner's stated goal — the server queue already turns
   "all entries added at once" into exactly one preflighted modelctl queue
   invocation. Web-only change; no new failure modes; no ADR rewrite.
2. C is a cheap, independent robustness win in modelctl (owner-owned, small Python
   surface) that closes the only string-contract risk ADR-0009 records. Recommended
   to land in the same batch, with the line-parser kept as fallback for older pins.
3. B solves a problem that bandwidth math says is minor (serial batches are near
   bandwidth-optimal); revisit only if the trickle-add experience actually annoys.
   ADR-0009 already lists "debounced dispatch" as a revisit trigger — keep it there.
4. D buys node-level durability the homelab doesn't currently need, at the cost of a
   second state system and a deployment/ADR revision. Revisit if long server outages
   with live serving become a real scenario.

## Summary of Findings

1. The popup's gap is **input UX only**: the server queue (ADR-0009) already batches
   everything pending into one modelctl queue run when the store node is idle
   (§1–2).
2. **Option A** (multi-entry modal — paste list and/or add-rows, batch POST) delivers
   the requested behavior with no modelctl change and no backend change beyond an
   optional batch endpoint. UI variant choice is the owner's.
3. **Option C** (modelctl `queue --json`) is a small, high-value modelctl change that
   removes the output-parsing fragility ADR-0009 records; recommended alongside A.
4. **Option B** (debounce coalescing) is deferrable — modest benefit, extra dispatch
   semantics + ADR amendment.
5. **Option D** (modelctl-native persistent queue, D1/D2) is the only variant that
   changes where the queue *lives*; large cost, benefit only under node-level
   durability requirements — rejected for now, revisit trigger documented.
6. Open decisions for the owner (each independent): (a) modal UX variant A1/A2/A3;
   (b) batch endpoint shape (one `POST {downloads:[…]}` vs N POSTs); (c) land C
   (modelctl `--json` + pin bump) now or later; (d) entry cap per submission
   (preflight cost scales with N; 25–50 reasonable); (e) whether per-entry advanced
   fields (revision/quantization/runtime/mmproj/mtp — already supported end-to-end
   by the agent builder) should surface in the modal now or later.
