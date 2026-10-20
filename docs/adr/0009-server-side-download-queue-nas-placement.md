# ADR-0009: Server-side download queue and NAS-preferred store placement

- **Status:** Proposed
- **Date:** 2026-10-20
- **Decision owners:** piresbruno
- **Scope:** Model downloads, jobs subsystem, model-ops node selection
- **Tags:** downloads, queue, jobs, nas, modelctl, hf
- **Supersedes:** None
- **Superseded by:** None

## Context

The /models "Download from HF" flow created a `download-queue` job on the **first
online node with `nasRoot` in list order** (`ModelsView.vue`). In the live fleet that
resolves to the dgx1 head (its `/mnt/nas` CIFS mount), not the NAS node — every HF byte
crossed the router into a Spark and out through a network mount, and a second download
added while any job ran on that node was rejected with the one-active-per-node 409.
modelctl cannot host the queue itself: its `queue` verb is an invocation-scoped YAML
batch (preflight-all → thread pool → exit; no daemon, no persistent state), so a durable
queue has to live in Irori. This refines the model-ops placement model of the supply
chain decision (ADR-0004) within the one-active-per-node job contract (ADR-0003).

## Decision drivers

- Owner requirement: adding a download must **always form a queue** — never a one-off
  start, never a 409 dead-end for downloads.
- Owner requirement: downloads should execute **on the NAS agent** — the store is local
  there and the NAS has the fast router link; fetching through a Spark's mount is a
  pointless extra hop.
- The queue must survive server restarts (jobs/subsystem state is PostgreSQL-backed).
- No store mutation outside modelctl; the agent's job-kind surface stays unchanged
  (security-sensitive privileged surface — ADR-0003).

## Considered options

### Option 1: Server-side DB queue feeding one-active-per-node batches (chosen)

Pending rows in a `download_queue` table; when the store node is idle, **all pending
entries dispatch as one `download-queue` job** (existing job kind; the agent builds the
same form-built YAML). Durable, keeps the job contract intact, modelctl gets one
preflighted batch with its own `--jobs` concurrency. Cost: a new table + endpoints and
dispatch/reconcile logic.

### Option 2: Multi-model modal only

Client collects N models and starts one job. Queue dies with the page, still 409s while
a job runs, and does not satisfy "always form a queue".

### Option 3: modelctl-native persistent queue

Does not exist today (invocation-scoped YAML only); would require daemon/state work in
the upstream Python project for an Irori-only need, growing a privileged dependency.

### Option 4: Agent-side queue

The agent holds pending entries. Agent job state is in-memory only — a queue would be
lost on agent restart, and it weakens the one-active-per-node contract the server
already enforces.

### Placement: NAS-preferred vs NAS-only vs list order

NAS-only blocks downloads entirely when the NAS agent is down; list order is what
misrouted to dgx1. Chosen: **NAS-kind node first, falling back to any other online
node with the store mounted** (the CIFS route) — the same preference the setups
transfer planner already applied, now one shared policy (`pickStoreNode` in
`packages/core`).

## Decision

Option 1 with NAS-preferred placement:

- `POST /api/v1/downloads` always inserts a pending row (validation via core schema);
  it never dispatches a per-node job directly. GET/DELETE/retry round out the queue.
- Dispatch selects the store node via `pickStoreNode` (NAS kind + `nasRoot` + enabled +
  online; fallback to other mounted nodes), drains **all** pending entries as one
  `download-queue` batch with `jobs` = max across entries, and retries on the 60 s
  reaper tick, on any job settle, and at boot (`recover()`).
- Batch outcomes reconcile onto rows: job succeeded ⇒ every entry succeeded (modelctl
  exits non-zero if any entry failed); canceled ⇒ canceled; failed ⇒ reconcile from
  modelctl's terminal `[i/n] complete|failed` output lines (printed last, so the
  400-line output ring retains them), unmatched entries fail with "did not complete in
  the batch". Partial failure/canceled batches trigger a `catalog-request` so the
  Models page reflects published entries.
- Retry re-queues a failed/canceled row (modelctl reuses published objects and resumes
  staging, so retries are cheap and idempotent).

## Consequences

### Positive

- Adds are never lost and never 409; the queue survives server and agent restarts.
- Downloads run on the NAS in the normal case — no CIFS hop, no Spark job slot held by
  a multi-GB transfer.
- Zero agent changes: the privileged command surface and job-kind set are untouched.

### Negative

- Consecutive adds form **separate batches** (modelctl's queue is fixed at invocation);
  a mid-batch add waits for the next batch. No coalescing of a running batch.
- New table + four endpoints to maintain.

### Risks and mitigations

- Output-line parsing drift across modelctl versions → a mismatch only mislabels a
  failed row; retrying reuses published objects (no re-download), and the
  catalog-request refresh keeps the Models page truthful. Minimum-version pin + golden
  tests guard the format.
- Store node prerequisites (modelctl ≥ pin, HF egress) are verified by the modelctl
  install job + `doctor`; a missing prerequisite fails the batch loudly in preflight,
  and rows fail (retryable) rather than half-writing the store.

## Implementation and validation

IRI-014: `packages/db` migration 0011 (`download_queue`), `download-queue-service.ts`,
`/api/v1/downloads` routes, web queue panel; db-gated integration tests
(dispatch/reconcile/cancel/retry/remove/recover), core policy tests, web chrome pins.
Live verification: `doctor` job on the NAS node; browser smoke of the queue panel.

## Revisit triggers

- modelctl grows a persistent queue/daemon API → consider delegating the queue.
- Batch-coalescing demand (mid-batch adds joining the running batch) → debounced
  dispatch could merge rapid adds.
- sync/push flows wanting the same durability → generalize the queue service to other
  job kinds.

## References

- Task `tasks/IRI-014-nas-agent-download-queue.md`; brief
  `docs/research/IRI-014-research-brief.md` (live fleet evidence + option tables).
- ADR-0003 (jobs/agent model), ADR-0004 (modelctl as supply-chain engine).
