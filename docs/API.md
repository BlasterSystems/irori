# API behavioral contract

Endpoint inventory lives in `SPEC.md` §6; this file records the behavioral
guarantees callers rely on, kept current when behavior changes. Last updated
2026-10-20 (M8 usage capture).

## Usage capture (M8, ADR-0008)

- `GET /api/v1/usage/overview|requests|errors|models?range=` — ranges
  `1h|24h|7d|30d|90d` (same enum as analytics); unknown range → `400`;
  degraded DB → `503`. Shared filters: `nodeId` (uuid), `model`.
  `requests` adds `errors=1`, `sig=<errorSig>`, `status`, `page`,
  `limit` (1–200, default 50); a row's full record is
  `GET /api/v1/usage/requests/:id` (404 unknown).
- Overview/models series read the watermark-guarded `usage_buckets`
  (hour for 1h/24h/7d, day for 30d/90d) keyed on **server ingest time**
  (`received_at`); the requests list and detail read raw `llm_requests`
  (90 d retention; buckets 1 y).
- Every captured request is also an SSE `usage` event (`{serverTimeMs,
  nodeId, request}`) sent after the durable insert; the events feed keeps
  them (only heartbeat/snapshot/llm are excluded).
- Agent sync: `usage-batch` frames (≤500 events) insert with
  `ON CONFLICT (id) DO NOTHING` and are answered with
  `usage-batch-ack {ids}` **only after** a successful insert — a failed or
  degraded insert sends no ack, and the agent's SQLite buffer redelivers.
  Redelivery is a no-op by UUID (exactly-once).
- **Rejections quarantine (IRI-070):** a schema-invalid event is never
  ack-dropped — it is stored verbatim in `rejected_usage` (capture id, node,
  setup, payload, first zod issue as `reason`) and acked with the rest, and
  `GET /api/v1/usage/overview` carries `rejected` (count in range) which the
  Usage view shows as a warn chip. A per-engine contract test pins the
  agent→hub event shape on every push (drift fails CI, not production).
- **Trace columns (IRI-070):** the proxy lifts `traceparent` verbatim
  (IRI-039) and the store derives `trace_id`/`span_id` columns on
  `llm_requests` (indexed) from it — one row joins its OTEL GenAI span.
- Setups: `captureProxy` on create/patch flips the head's engine port to the
  agent's capture proxy. Flagged setups get **no `PORT` env from the
  server** — the agent binds the declared port and injects a fresh loopback
  engine port as `$PORT` at spawn (the start script must honor it). Health
  probes and LLM probes target `127.0.0.1:<port>` and work through the
  proxy unchanged; unflagged setups are byte-identical to before.

## Download queue (IRI-014, ADR-0009)

- `POST /api/v1/downloads` `{source, name?, quantization?, mtp?,
  draftSpecType?, force?, jobs? (1–16, default 4)}` — **always queues**: `202 {entry}` with the row in
  `pending` (or already `running` when the store node was idle and the batch
  dispatched immediately). Adding a download NEVER starts a one-off per-node
  job and never returns 409. Invalid payload → `400`; degraded DB → `503`.
  IRI-016: `quantization` is the modelctl `--quantization` substring (GGUF
  repos with several quants require it); `mtp` is an explicit draft
  companion path (modelctl otherwise auto-selects the single root draft, or
  the single root Q8_0 draft when there are several). IRI-152 (ADR-0020):
  drafts are `mtp-`/`dspark-`/`dflash-`/`dflash2-` files or files under a
  matching directory; `draftSpecType` (`^[a-z0-9][a-z0-9-]{0,31}$`) is the
  llama.cpp `--spec-type` override passed as modelctl `draft_spec_type`, and
  is omitted from the agent payload when absent (modelctl derives it from the
  draft kind). Entries echo `draftSpecType` (null when unset). **Requires
  modelctl ≥ 0.25.0 and an IRI-152 agent:** an older modelctl rejects the
  unknown queue key and fails the whole dispatched batch (co-batched entries
  included); an older agent drops it silently. Clients send it only when it
  differs from the draft kind's default. A quantized entry without an explicit name derives
  `{repo tail}-{TAG}`. IRI-017: `force` opts the entry into replacing an
  existing manifest with different settings (modelctl per-entry `force`;
  without it a conflicting manifest fails the batch preflight).
- **Bulk form (IRI-015)**: `POST /api/v1/downloads`
  `{downloads: [{source, name?, quantization?, mtp?, draftSpecType?, force?}…] (1–50),
  jobs?}` → `202 {entries}` (same per-row states). Atomic: any invalid entry
  rejects the whole submission with `400` and nothing lands. Single-row bulk
  submissions are equivalent to the single shape.
- The server picks the store node (`pickStoreNode`: `nas`-kind node with
  `nasRoot` first, then any online node with the store mounted). Pending
  entries drain as **one `download-queue` batch** on the idle node — drained
  on enqueue, on any job settle, on the 60 s reaper tick, and at boot.
- `GET /api/v1/downloads` → `{entries}` (newest first, last 50);
  `DELETE /api/v1/downloads/:id` removes a pending or terminal row (404
  unknown, 409 while the entry is in the running batch — cancel the job
  instead); `POST /api/v1/downloads/:id/retry` re-queues a failed/canceled
  row (409 otherwise) — body `{force?: true}` opts the retry into manifest
  replacement (IRI-017).
- Batch reconcile: job `succeeded` ⇒ every entry succeeded (modelctl exits
  non-zero if any entry failed); `canceled` ⇒ entries canceled; `failed` ⇒
  per-entry status from the modelctl `queue --json` results document
  (single-line JSON, last stdout line — IRI-015) when the pinned modelctl
  emits it, falling back to the `[i/n] complete|failed` output lines
  otherwise; unmatched entries fail with "did not complete in the batch".
  Partial failure/cancel still triggers a catalog refresh. Retry is cheap:
  modelctl reuses published objects and resumes staging.

## HF quantization listing (IRI-016)

- `GET /api/v1/hf-quants?repo=owner/model` — read-only proxy of the public
  HF API for the download modal's expand-quants flow. Returns
  `{repo, modelCard, quants: [{tag, files, sharded, shards, bytes,
  ambiguous}], companions: {mmproj: {candidates, default}, mtp: {candidates,
  default}}}`. `tag` is a substring needle unique across the repo's GGUF
  groups (pass it as `quantization`); `ambiguous` rows cannot be selected.
  Companion `default` is modelctl's auto-pick (single f16 mmproj / single
  root draft, else the single root Q8_0 draft, else the only candidate);
  null means modelctl needs an explicit choice. IRI-152: `companions.mtp.candidates[].kind` is the draft
  kind (`mtp|dspark|dflash|dflash2`); drafts and `*imatrix*` files never
  appear in `quants`.
  Errors: `400` invalid repo id, `404` missing/not public, `502` HF
  unreachable or unusable response. No store required (works degraded).
  IRI-019: when a global HF token is configured, the upstream request carries
  `Authorization: Bearer <token>` (gated/private repos answer); without one
  the request is unchanged.
  IRI-153 (ADR-0020): GGUF listings also carry `hints: {draft, mmproj,
  specType, source: "readme"|"docs"|null, url, error}`. These are run hints
  parsed from `llama-server`/`llama-cli` snippets: first the repo README at
  the resolved commit, then at most 3 README links on the doc-host allowlist
  (`IRORI_HF_DOC_HOSTS`, default `huggingface.co,unsloth.ai,docs.unsloth.ai`;
  empty disables doc fetches). Every path names a file in the repo's own
  listing, so hints are preselections, never new files. The README wins
  field by field, and docs pages are searched until one resolves a draft.
  Doc fetches are https-only on port 443, follow redirects manually
  (allowlisted, at most 2 hops), stop reading after 2 MiB, never carry the HF
  token, and never fail the listing (`error` is informational). Each hop
  times out after 5s, and the whole hints computation has a 10s budget, so
  the endpoint answers within about 20s (10s HF listing + 10s hints).
  Successful results are cached per (repo, commit) for 10 minutes; failures
  aren't cached.

## Hub settings — global HF token (IRI-019, ADR-0009)

- `GET /api/v1/settings/hf-token` → `{configured: boolean}` — **presence
  only**; the token itself never appears in any response body. `503` while
  the DB is degraded.
- `PUT /api/v1/settings/hf-token` — `{hfToken: string | null}`: a non-empty
  string sets the hub-wide token, `null` clears it (settings row deleted);
  anything else → `400`. On success every online agent receives a
  `config-update` with the new value; offline agents get it in the
  config-update that follows their next hello. `503` while degraded.
- The token rides `config-update` frames only (never job params or
  job-output frames); the agent applies it as the modelctl child `HF_TOKEN`,
  and a hub-set token wins over the agent's `IRORI_HF_TOKEN` (bootstrap
  fallback). The token is always optional — unset, nothing is sent anywhere.

## Hub settings — snapshot cadence

- `GET /api/v1/settings/cadence-ms` → `{cadenceMs: number | null}` — the
  persisted hub cadence; `null` means unset (the `CADENCE_MS` env default
  governs). `503` while the DB is degraded.
- `PUT /api/v1/settings/cadence-ms` — `{cadenceMs: number}`, bounds 1000–60000
  (else `400`). Persists a settings row, updates the hub's in-memory active
  value immediately, and live-pushes a `config-update` to every online agent —
  agents re-arm their snapshot timer without reconnecting; the rest read it in
  the next `hello-ok`. `GET /api/v1/version` includes the active `cadenceMs`.
  `503` while degraded.

## Audit log + event journal (IRI-077)

- `GET /api/v1/audit?range=&actor=&domain=&targetId=&q=&cursor=&limit=` — the
  durable record of hub mutations (`audit_log`): `actor` (`hub|agent|client|
  anonymous`), `action` (`domain.verb`), `targetType`/`targetId`, one-line
  `summary`, and the `before`/`after` shapes with secret-bearing keys redacted
  to `***` at insert time. Ranges `1h|24h|7d|30d|90d|1y`; cursor is the
  descending decimal-string `id` of the last row shown; `total` is the bounded
  count for the filter ignoring the cursor. `503` while degraded. Mutating
  routes opt in via the `audit()` middleware; reads never record. A refused
  mutation is recorded too (`outcome: error`) with the guard's message from
  the response body, not just the status (IR-193).
- `GET /api/v1/events/journal?range=&type=&nodeId=&limit=&cursor=` — outgoing
  SSE frames persisted at emit time (`event_journal`, 90 d), so operational
  history survives hub restarts (the `/api/v1/events/recent` ring is
  memory-only). Cache-stream frame types are excluded at journaling time.
  `payload` validates as the same `sseEventSchema` the live feed carries.
  `503` while degraded.
- Both pass through the retention service (`AUDIT_KEEP_DAYS`, fixed 90 d for
  the journal).

## Durable logs (IRI-078)

- `GET /api/v1/logs?nodeId=&setupId=&runId=&jobId=&scope=&source=&level=&q=&range=&limit=&cursor=&after=`
  — the durable record behind the rings (`logs`): every setup/engine line
  (driver markers, engine stdout via the run-log tailer, capture-proxy lines),
  job output, and agent/hub lifecycle lines, with `scope`
  (`setup|job|agent|proxy|hub`), `source` (`driver|engine|proxy|system`),
  `level` (`trace…error`, heuristic on raw lines), per-(setup, run) `seq` and
  the agent's `eventTs` alongside the hub ingest `ts`. `q` is a
  case-insensitive substring match on the line; `level` is an inclusive
  minimum; `cursor` pages backward (newest first); `after` switches to
  ascending tail mode (`id > after`) for the live view. `latestId` is the
  newest stored id in range (the tail resume point); `truncated` is true when
  a node's queue dropped lines in the window (`log_drop_counters`).
  `503` while degraded.
- `GET /api/v1/logs/summary` — the same filters without paging; per-level
  `counts` + `total` + `truncated` for the filter-bar chips.
- Agent → hub: `log-batch` WS frames (≤200 events, `dropped` cumulative
  counter) acked with `log-batch-ack {ids}` only after a durable insert —
  redelivery dedupes on `eventId`, so an agent restart replays without
  doubling a line. The hub fans out one `log-update` SSE pulse per stored
  batch (excluded from the feed ring and journal; the row itself is only in
  the table).
- Retention: raw rows below `warn` for `LOG_KEEP_DAYS` (30 d); `warn`+ for
  `LOG_WARN_KEEP_DAYS` (180 d).

## Analytics (M7)

- `GET /api/v1/analytics/:lens?range=&groupBy=` — five lenses
  (`memory|decode|power|temps|tokens`), ranges `30m|1h|24h|7d|30d|90d`,
  `groupBy=cluster|node` (cluster = a serving setup; nodes in no setup fold
  into a `standalone` group). Optional `setupId`/`nodeId` filters. Answers
  from the rollup buckets — never raw scans. Temps uses minute buckets for
  the 7d range (min/max pairs); every other combination uses hour/day.
- Aggregation semantics are per lens and physical: decode/tokens/power/memory
  add across members; temps aggregate fleet-max (max-of-max, min-of-min,
  mean-of-avg, any-throttled). Power points carry `baseW` and a `coverage`
  fraction; watts are clamped to the 240 W GB10 envelope and labeled
  estimated, not wall-metered.
- The tokens lens additionally returns `models[]` — per-model
  generated/prompt/cached totals over the range from the ledger. Ledger
  columns reflect only counters the backend actually published; an unpublished
  counter is NULL-coverage, never a zero.
- Tokens lens macro fields (IRI-040): the response additionally carries
  `fleet` — the five macro metrics (`total` = generated + prompt, `generated`,
  `prompt`, `cached`, `cacheHitPct` = cached / prompt × 100, 0 when prompt is
  0) summed over the same scope as `series` (filters applied); `models[]`
  gains `total` and `cacheHitPct` and covers the whole ledger for the range
  (never a top-N subset, capped at 100 rows, sorted by total). `fleet` is
  `null` for every other lens.

## Disk hygiene (M7)

- `GET /api/v1/nodes/:id/cleanup` — `{latestAudit, history (last 20),
  prevention}`; `PUT /api/v1/nodes/:id/hygiene` — `{weeklySafePass: boolean}`.
- `hygiene-audit` / `hygiene-clean` / `hygiene-prevent` are agent-side jobs
  (one active per node, 409 otherwise). The agent's FINAL output line is the
  JSON report (validated against the core schemas) and lands in
  `cleanup_runs.report`; a clean's categories continue past a failing
  category (per-category `failed` outcome). The protected set — modelctl
  registrations, running-container images, `/proc` open files, files <24 h
  outside caches, the NAS store — is enforced agent-side; `modelctl-staging`
  cleans go through `modelctl cleanup-staging --apply`, never raw `rm`.
- IRI-028: each audit category also carries `details: [{label, path, bytes,
  items}]` — the concrete targets behind `reclaimableBytes` (old images, HF
  incomplete blobs vs unreferenced snapshots, staging entries, compiler
  cache dirs, journal/tmp/core dirs). Older agents omit it (defaults to `[]`).
  The drawer runs the audit, then the armed clean directly; `hygiene-clean`
  still accepts `dryRun: true` for scripts, but the UI no longer plans first.
- `hygiene-prevent` writes docker `daemon.json` log rotation (backup kept)
  and records `logRotationApplied` in the node's prevention settings; docker
  is NOT restarted by the agent (it may live on that daemon).

## Node model inventory (IRI-028)

- `GET /api/v1/nodes/:id/models` → `{report: NodeInventory | null, updatedAt}`
  — the cached `models-inventory` report. `report.store` is the modelctl store
  (active models + failed-delete leftovers) when the node has a `nasRoot`;
  `report.local[]` is one entry per user HF cache (`user`, `home`, `cacheDir`,
  `modelctlVersion`, `error`, `models[]`). Modelctl local state is per user,
  so a root agent lists each cache owner through `runuser`.
- `POST /api/v1/nodes/:id/models/refresh` → `202 {job}` dispatches the
  read-only `models-inventory` job (409 while the node has any active job;
  agents older than 0.4.0 fail it with "unknown job kind"). The hub persists
  the job's final JSON line into `node_inventory` and deletes the row whenever
  a model-mutating job settles (`download*`, `sync-local`, `push`,
  `nas-delete*`, `delete-local`, `gc-objects`, `cleanup-staging`,
  `catalog-refresh`, `repair-active-apply`).
- Deletes from the node page reuse existing kinds: `nas-delete-apply`
  (store), `delete-local` (local registration, params `{name, user}` — the
  agent resolves the binary/home/cache dir, never the request) and
  `gc-objects` (leftover, params `{targets: [ORG/REPO/COMMIT--SELECTION],
  apply: true}`).
- `nas-delete-apply` now preflights: the agent runs `modelctl delete NAME
  --json` (read-only plan), probes every object/staging directory with a
  create+unlink, and only then runs `--apply --yes`. A denied tree fails the
  job with the failing path/errno and leaves the model ACTIVE.
- `nas-delete-batch` deletes several store models in one job: params
  `{names: [string]}`. Per name the agent runs the same plan → preflight →
  `--apply --yes` sequence as `nas-delete-apply`; output is one JSON line per
  model (`{model, status: "deleted"|"failed"|"skipped", error?}`) plus a final
  summary line (`{kind, total, deleted, failed, skipped, results}`). Invalid
  names and duplicates are `skipped` without exec; a failed model never stops
  the batch; a cancel marks the remainder `skipped: canceled before delete`.
  The job succeeds only when every name ended `deleted`; agents predating the
  batch kind fail it with "unknown job kind". A succeeded settle prunes each
  name's placement and drops cache rows no node still holds; a failed settle
  keeps placements and still requests a catalog re-read.
- `staging-tree-audit` walks the store's `.staging` including hidden dirs
  (`.active-quarantine` per model/stamp, `.cleanup-quarantine` per id) —
  `staging-audit` cannot see dot-dirs. Read-only; the final JSON line carries
  per-tree bytes, totals, and the statfs free space. `quarantine-prune`
  prunes `.active-quarantine` trees per model NAME through `modelctl
  cleanup-quarantine`, which validates the repaired reference and every
  copy's metadata before deleting: a dry run without `confirm: "prune"`,
  armed with it; per-name result lines plus a final summary with the statfs
  freed-bytes delta. `prune-cleanup-quarantine` (IR-207, modelctl 0.24.0)
  removes the `.staging/.cleanup-quarantine` debris an interrupted
  `cleanup-staging --apply` leaves behind — dry-run unless
  `confirm: "prune"`; only direct children of that directory are ever
  touched, and the final summary line carries `applied`, the statfs
  freed-bytes delta, and per-tree rows.
- The global Models cache (`model_meta`) self-heals: a `catalog` frame carries
  the agent's complete store catalog (catalog.json schema 3), so the hub drops
  cache rows the store no longer has — store changes made outside hub jobs
  (direct modelctl) reconcile on the next frame. `scan` fallback frames and
  empty catalog frames never prune. Any catalog-mutating job settle —
  succeeded OR failed — asks the node to re-report its catalog.
- Installed companions (IRI-155, ADR-0020): each `catalog` frame entry may
  carry `companions: {mmproj: {path, bytes} | null, draft: {path, bytes,
  specType} | null} | {unreadable: true} | null`, read by the agent from the active object's
  `.modelctl.json` (not the manifest), with the object confined to the store,
  the file opened without following symlinks and capped at 1 MiB, 2 s per
  read, 8 reads in flight, and a 10 s budget for one catalog's per-model
  reads (entries not read in time report unreadable). The node inventory job skips these reads. `draft` is modelctl's `mtp` companion key (MTP,
  DSpark or DFlash); `specType` is the object's recorded `draft_spec_type`
  (null = the kind default applies); `bytes` comes from the object's
  `files[]` (null when not recorded); paths are relative, without `..`.
  **Absent = unknown** (an older agent): the hub keeps what it stored.
  **`null` = known, none** (no companions recorded, or an older object with no
  metadata file). **`{unreadable: true}`** = the read failed (timeout, I/O
  error, corrupt or oversized metadata, a link outside the store); it
  replaces any stored value, so the page never shows companions it could not
  confirm on the last read. A `companions` shape the hub doesn't recognise
  (a newer agent) is treated as absent, never as a reason to drop the frame.
  The hub merges the value
  into `model_meta.meta.companions`, and `GET /api/v1/models` rows expose it
  as `companions` (absent until an agent has reported it). Older hubs and
  clients strip the field.

## Job activity (IRI-028)

- SSE `setup-log` `{setupId, nodeId, name, line}` (IR-124): throttled engine
  output for the shared telemetry feed — ≤1 frame/s per setup while the setup
  is running, relaxed to ~10 frame/s while its driver state is `starting`
  (weight loading, IR-148); identical consecutive lines always skipped,
  live-only (excluded from
  `/api/v1/events/recent`; `GET /api/v1/setups/:id/log` stays the backfill
  source). Older web bundles ignore it.
- `GET /api/v1/jobs?limit=` → `{jobs: [{...jobInfo, lastLine}]}` — recent jobs
  across every node, newest first (limit 1–100, default 20). Rows carry
  `progress` (parsed transfer progress, see below) and
  `cancelRequestedAt` (ISO timestamp when a cancel is in flight).
- `DELETE /api/v1/jobs` (IR-262) → `{deleted: n}` — clears the transfers
  dock's history: every settled row (succeeded/failed/canceled) is deleted,
  queued/running rows and the one-active slot are untouched, `job_output`
  cascades and `download_queue`/`cleanup_runs` references go NULL. Audited
  (`jobs.clear-history`). `503` while the database is unavailable.
- SSE `job` frames now also fire on dispatch with `status: "running"`
  (`exitCode`/`durationMs` null); terminal frames are unchanged.
- SSE `job-progress` `{nodeId, jobId, seq, line}` carries at most one output
  line per second per job. For single-stream `sync-local`/`push` jobs it also
  carries an optional `progress` object (`bytes`, `percent`,
  `rateBytesPerSec`, `etaSeconds`) parsed from the rsync line — multi-stream
  jobs (`--jobs > 1`) never get one, because their interleaved per-stream
  lines would show a misleading fraction of one stream. It is not recorded in
  `/api/v1/events/recent` (the full 400-line ring stays in `job_output`).
  Older web bundles ignore both frames.

## Job cancel (IR-131)

- `POST /api/v1/jobs/:id/cancel` no longer writes `canceled` speculatively:
  it sends the agent the cancel frame and marks the row with
  `cancel_requested_at` (the row STAYS running, so the one-active slot stays
  held). The row settles `canceled` on the agent's `job-cancel-ack` (the kill
  signal was issued) or its terminal `job-done {canceled}` — whichever lands
  first; a repeated terminal frame is a no-op.
- Honest failures (all `409` with `{"error": ...}`): `job not found`,
  `job not cancelable` (terminal), `cancel already in flight`,
  `agent-update cancel is not supported` (ADR-0007: settlement is
  hello-driven), and `node offline — the transfer process may still be
  running` (the frame could not be delivered; the row is untouched and the
  reaper still owns it).
- Agent restarts no longer strand rows: the agent persists its active jobs
  (`{jobId, pgid, kind, startedAt}` under `IRORI_STATE_DIR`), kills the
  persisted process groups on boot, reports them failed, and its hello
  carries `activeJobs` — the hub settles any running/canceling row the fresh
  agent does not report. Old agents send no `activeJobs`; for those the hub
  skips the reconcile (a ws reconnect without a restart still has live jobs
  the old agent cannot report).

## Nodes

- The agent token is returned **exactly once**: `POST /api/v1/nodes` →
  `{node, token}`, `POST /api/v1/nodes/:id/token/rotate` → `{token}` — registry
  payloads never carry it. The web NodeModal (IRI-010) is the UI surface for
  this contract: one-time reveal with the agent env block and the hub-served
  install block (IRI-011).
- `POST /api/v1/nodes` persists `llmPorts` (as `127.0.0.1` probe assignments)
  and `nasRoot` — a create with a NAS root yields a model-ops node, not a
  silently dropped field. `cacheUser` (IR-101, optional validated username) is
  persisted the same way: transfers (`sync-local`, push source) run as that
  user so models land in their HF cache; unset = the agent user (root).
- `PATCH /api/v1/nodes/:id` accepts `llmPorts: number[]` per the core
  contract and coerces them to `{port, host: "127.0.0.1"}` assignments at the
  store boundary, so `config-update` keeps probing them. Only keys present in
  the request body are applied (absent `llmPorts` never wipes stored values).
  `cacheUser` follows the same rule; `null` clears it. The hub hands the value
  to the agent in every `config-update`.
- `role` (`head|worker|standalone`) is **derived from serving-setup
  membership** (IRI-050): on setup create/patch/remove the server re-derives
  roles over all setups — `head` if the node is any setup's `headNodeId`
  (taking precedence over worker claims), else `worker` if it appears in any
  setup's worker list, else `standalone` — and pushes a fresh
  `config-update` per changed node (workers probe detection-only at 10 s).
  Only the changed members of the edited setup are written, so a manual
  `PATCH /api/v1/nodes/:id` role (e.g. marking a non-setup engine `head`)
  survives until that node's own membership changes. Deleting a node strips
  its id from surviving setups' worker lists (the FK only cascades setups it
  heads).
- `PUT /api/v1/nodes/:id/llm-ports` (`{ports: number[]}`) remains the
  dedicated probe-assignment endpoint and hardcodes the probe host to
  `127.0.0.1`.
- `GET /api/v1/nodes/:id/llm` — the live probe view: the in-memory ring first,
  then the latest persisted pass; `{ports, updatedAt}`. `404` when nothing is
  known yet — except for a `kind: nas` node, which has no LLM surface at all
  and answers `200 {ports: [], updatedAt: null}` (IR-192).

## Cost (IRI-072)

- `GET /api/v1/usage/cost?groupBy=model|client|setup|day|node&range=…` —
  `{totalMinor, currency, rows: [{key, requests, promptTokens, completionTokens,
  cachedTokens, costMinor}]}`; `costMinor` is null for unpriced groups (never
  a fake zero). Consistent with `usage.overview` cost totals and the underlying
  `usage_buckets` stamps.
- `GET /api/v1/settings/token-cost` / `PUT …/token-cost` (`{input, cached,
  output, currency}` — €/Mtok per class) — the global default price.
- `GET /api/v1/settings/model-prices` / `PUT …/model-prices` (`{pattern,
  input, cached, output, currency}`) / `DELETE …/model-prices/:pattern` —
  per-model overrides; exact match beats the longest glob prefix beats the
  default. Writes re-price stamped buckets via the resumable backfill.

## Power actions (IRI-068)

- `POST /api/v1/nodes/:id/shutdown` — two-step armed confirm (node-delete
  idiom). Step 1 (empty body) arms: `{armed, confirmToken, expiresAt}` (60 s).
  Step 2 (`{confirmToken, origin?}`) validates the token — a stale, reused, or
  unknown token is rejected `409` and audited — then dispatches
  `node-shutdown` to the agent: it logs the origin, acks, and powers off after
  a 10 s grace (`systemctl poweroff`). The audit row is written before
  dispatch; the dispatch never rides an SSE-reconnect path.
- `POST /api/v1/nodes/:id/wake` — Wake-on-LAN: magic packet to the node's
  `/24` directed broadcast (derived from `host`) plus the global broadcast,
  using the stored `wolMac` (or `{mac}` in the body). `400` when neither
  exists.
- `PUT /api/v1/nodes/:id/clock-cap`
  (`{capMHz?: number|null, cpuCapMHz?: number|null, persistent?}`) — applies
  GPU and CPU clock caps through the agent (IRI-067/IRI-124 clocks verb).
  The halves move independently: an **absent** field leaves that side alone,
  `null` clears it (GPU → `nvidia-smi -rgc`; CPU → every cpufreq policy back
  to `cpuinfo_max_freq`). Stores `gpuClockCapMHz`/`gpuClockCapPersistent` and
  `cpuClockCapMHz`/`cpuClockCapPersistent` on the node. With `persistent`
  the matching oneshot (`irori-gpu-clock-cap.service`,
  `irori-cpu-clock-cap.service`) is installed — or removed when the cap is
  null, which is how a Clear survives the next boot. A foreign unit or script
  with the same path is refused, never overwritten. `400` when neither cap is
  present, a value is not an integer in 300–4000 MHz, or `persistent` is
  truthy with no cap field at all. Each side is applied in its own agent
  frame, so a landed half is stored (`gpuClockCap*` / `cpuClockCap*`) even
  when the other fails: a partial failure answers `502` with a per-side
  `results` array and the registry values read back; `504` means the agent did
  not answer (a CPU-only frame on an agent older than IRI-124 is dropped
  outright, so that path also lands here with the update hint).
- `POST /api/v1/clock-cap` (IR-189) — the same body and per-side contract as
  `PUT …/clock-cap`, fanned out to **every enabled spark node** (NAS hosts are
  skipped: no GPU, no cpufreq policy). Each node is applied independently and
  reported: `{results: [{nodeId, name, status, results: [{side, ok, offline,
  error, appliedMHz}]}], applied, failed, persistent}` — `appliedMHz` (IR-199)
  is the cap the node now runs (the requested value), `null` for a cleared or
  failed side; sides left alone get no entry. `200` when every node applied,
  `207` when some did, `502` when none did, `503` when the agent hub is
  unavailable. Audited
  (`fleet.clock-cap.post`).
- **Re-apply on node online (IR-189):** every authenticated agent hello
  re-asserts the stored caps — the hub reads the live clocks, compares each
  side with the applied ceiling (`gpus[].smCapMHz`, `cpu.capMHz`), and
  re-applies only the drifted sides. Persistence is never touched. A side is
  compared only when a cap is stored and the reading can express it (an agent
  without the `cpu` block, an empty `gpus` array, or an all-null `smCapMHz`
  read-back — GB10 cannot report application clocks — is not measurable; one
  real reading among the cards still compares). The
  health sweep evaluates a `clock_cap_drift` rule whose value is the number of
  consecutive 30 s sweeps that observed a mismatch (seed threshold 4 = two
  minutes).

## Efficiency — Wh per token (IRI-073)

- `GET /api/v1/analytics/efficiency?range=&groupBy=node|model` — read-time
  join: energy (Wh) from power buckets clamped to the GB10 envelope × bucket
  duration, tokens from the ledger → `whPerKToken`, plus an estimated
  `costPerMToken` (pricing snapshot × ledger tokens). **The NAS is excluded
  from energy** (fleet rule) — efficiency is never computed against idle box
  watts. Missing coverage → `whPerKToken: null` + `reason` (partial power
  coverage < 50%, no readings, no token counters), never zero. The Analytics
  tokens lens renders a per-node statgrid (reason in the tooltip) and a
  per-model `Wh/ktok` column.

## Version provenance (IRI-080)

- `GET /api/v1/nodes/:id/versions` — standing versions + drift: agent version,
  node runtime, uv, catalog.json freshness, per-cache-user modelctl vs the
  hub pin (`drift[].belowPin`), and the setups' recipe-script stats (missing
  script → the Serve stale-recipe chip). Contract additive: agents without
  the report `versions` block render unknowns.

## Community intelligence (IRI-083)

- `GET /api/v1/community` - top topics (keyword clustering over titles),
  latest items, engine/recipe release watch, per-source poll health.
  Conditional-GET (etag) pollers run hub-side on jittered intervals with a
  shared UA and a circuit breaker (open after 5 consecutive failures; a dead
  source shows a warn chip and never blocks the panel). The GB10 forum source
  (`forum:gb10-top`) polls the category-scoped
  `…/dgx-spark-gb10/719/l/latest.json` — the GB10 subtree (719 parent, 721
  GB10, 723 Projects) — and stamps topics with their last activity
  (`bumped_at`), so the client period filter reflects recent posts (IR-245).
- `POST /api/v1/community/:id` - owner curation `{hidden?, pinned?, seen?}`.
- X posture: identity-only rows (post id + author handle + canonical URL +
  first-seen); bodies hydrate at view time; the allowlist is owner config,
  never scraped.

## Curated recipes (IRI-082)

- `GET /api/v1/recipes` - the catalog (SparkRun v2 YAML entries transpiled at
 install; MiaAI script recipes staged verbatim). Unpinned entries (offline
 boot) stay hidden until the pin pass lands. Seeds ship in-repo
 (`apps/server/src/recipe-seed.json`, versioned) and upsert on boot.
  The MiaAI-Lab per-model recipe repos (IR-246) are seeded as `miaai-script`
  entries — raw start.sh/stop.sh staged from the pinned commit at install
  (sha256-verified by the agent), never vendored; AGPL repos are marked
  `copyleft`. Per-repo commit feeds (`atom:miaai-*` community sources) watch
  them for updates.
- `POST /api/v1/recipes/:id/install` - stages the start/stop scripts onto the
 target node via a `recipe-install` job (sha256-verified by the agent; AGPL
 bodies pass through at install time and are never vendored into the bundle).
- `GET /api/v1/recipes/drafts/:jobId` - the settled job yields a wizard draft
 (core `recipeInstallSchema`); the operator confirms in Serve
 (`#/serve?recipeJob=<id>` deep-link) - nothing auto-starts.
- `POST /api/v1/recipes/:id/pin|hide` - re-pin to the upstream default-branch
 SHA; hide a card. Recipe caveats render verbatim on every card (core
 `RECIPE_CAVEATS`: IR-151 status demotion + capture endpoint pattern).

## Update posture (IRI-081, IR-243, IR-255)

- `GET /api/v1/updates` - the fleet matrix: `baseline` (scraped DGX Spark
 release notes, cached in settings, refreshed at most daily; `source` is
 `live` or `cache`) plus per-node rows `{nodeId, name, online, posture,
 reportAt, updates}`. `posture` is `up to date`, `behind` (DGX OS or driver
 differs from the baseline — IR-243 keeps generic apt upgradable counts
 informational), `pending reboot`, `update tooling absent`, or `unknown`.
 A pending NVIDIA/DGX package subset (`nvidiaDgxPending` — the DGX OTA
 channel, what the DGX dashboard's update banner reads) is verdict-bearing:
 more than zero flips the posture to `behind` (IR-258).
 `reportAt` (IR-255) is when the node's inventory report was collected
 (null = no report); the node-page Updates card renders its age. `updates`
 mirrors the agent's read-only probe: OS, kernel, DGX OS, NVIDIA driver,
 firmware updates via fwupd (`fwupdPresent` false = fwupdmgr produced
 nothing — IR-256), NVIDIA OTA packages, pending reboot, unattended-upgrades
 last result, apt upgradable count, apt presence. Irori never installs or
 reboots.
- A confirmed `agent-update` settle voids the node's cached inventory report
 (IR-255): the old report was collected by the previous bundle, so the next
 node-detail read re-collects with the new agent. Failed updates keep it.

## Trace inspector (IRI-079)
- `llm_requests` carries typed timing columns parsed from the TensorFold
  engineMeta at ingest (`prefill_ms`, `decode_ms`, `spec_rounds`,
  `spec_drafted`, `spec_accepted`; the verbatim jsonb stays). Reset-safe
  parser: unknown shapes yield nulls.
- `GET /api/v1/usage/requests/:id/trace` — normalized span tree whose
  segments sum to `durationMs`; engines without a breakdown degrade to two
  segments (TTFT + decode). The drawer renders it as a waterfall with the
  speculative acceptance rate and a Copy-trace-id button (the trace id joins
  logs/OTLP externally).

## Cost of errors, sessions & retries (IRI-076)

- `GET /api/v1/usage/requests/:id` + the list rows carry a read-time priced
  `costMinor` (pricing snapshot × row model/tokens; failed requests keep
  prompt tokens); the responses carry `costCurrency` — the drawer shows the
  Cost row, unset pricing renders nothing.
- Errors tab: `usageErrorsResponseSchema.errorsCostMinor/costCurrency` +
  per-signature `costMinor` (priced per sig × model) — the expensive failure
  mode is a column + a COST OF ERRORS chip.
- Chats: `chatSessionSchema.costMinor` summed over the session's requests
  (usage-chats prices rows once via `opts.pricing`); the list row shows it.
- `GET /api/v1/usage/retries?range=&nodeId=` — superseded attempts
  (`retry_superseded_by` set) grouped per client key: `attempts`, priced
  `costMinor`, plus `retriesCostMinor` (the money a retry storm burned).
  Rendered as the Usage "Retries" tab.

## Token reconciliation (IRI-071)

- `GET /api/v1/analytics/token-reconciliation?range=&nodeId=` — per
  node/port/model: `{ledgerTokens}` (engine lifetime counters, M7 ledger) vs
  `{captureTokens}` (llm_requests), `delta`, `divergencePct`, and `warn`
  (both sides have data and diverge > 20%). The tokens lens renders the
  table with the warn chip; **costs are priced from the capture side** — both
  sources are labeled, never silently preferred.
- SGLang now feeds the ledger: `generation_tokens_total` +
  `realtime_tokens_total{mode=prefill_compute|prefill_cache}` (prompt =
  compute + cache, cached = the cache subset) with a `server_info` totals
  fallback. ollama and LM Studio publish no cumulative token counters over
  their HTTP APIs — the ledger records no-coverage for them (never a guess).

## Health rules, findings & metrics (IRI-069)

- `GET /api/v1/health/rules` — the seeded rule set (GPU temp warn/critical,
  disk warn, kernel Xid, throttle, power envelope, node offline, telemetry
  gap, hub disk warn (IR-201, fleet-scoped — `nodeId` is `null`/absent in
  fleet findings and the wire maps it to `""`)) with live thresholds. `PUT
  /api/v1/health/rules/:id` (`{name?,
  threshold?, severity?, cooldownSec?, enabled?, webhookUrl?}`) tunes a rule;
  the webhook URL is stored encrypted (ADR-0002) and never returned
  (`hasWebhook` only). Audited.
- Metric ids (core `healthMetricSchema`): `gpu_temp_c`, `disk_pct`,
  `kernel_xid`, `throttle_active`, `power_w`, `node_offline`,
  `telemetry_gap_s`, `reconnect_storm`, `clock_cap_drift`, `hub_disk_pct`
  (fleet), `db_unavailable` (fleet). Snapshot-driven ids evaluate on ingest
  through the wrapped store (IR-204); fleet gauges evaluate once per 30 s
  sweep, never per request.
- Evaluation runs on snapshot ingest + a 30 s offline/gap sweep; open/clear
  transitions emit `health` SSE events (journaled) and one webhook POST per
  cooldown window per rule. `GET /api/v1/health/findings` returns the open
  findings (NodeDetail renders severity chips; the Overview `HealthBanner`
  renders the fleet rows plus node-disk rows with the clean-up-disk CTA —
  IR-203/IR-204 — and the ops steps live in `docs/DEPLOYMENT.md`,
  "Signal runbook").
- `GET /api/v1/health/thresholds` — the UI threshold values (temp warn /
  critical, disk warn, hub disk warn (IR-201), database unavailable (IR-202));
  the web has no second copy.
- Fleet-scoped gauges evaluate once per 30 s sweep, never per request: the
  hub's own filesystem (`hub_disk_pct` via `HUB_DISK_PATH`, IR-201) and
  database availability (`db_unavailable`, 1 = the same boolean `/healthz`
  reports, IR-202) — a failed gauge resolves to not-measurable and skips the
  rule.
- `GET /api/v1/metrics` — Prometheus text exposition (irori_up, per-node
  gauges, irori_collector_last_success_timestamp_seconds). **404 while
  disabled**; `GET/PUT /api/v1/settings/metrics` flips the flag (audited).

## Clocks (IRI-067, CPU half IRI-124)

- `GET /api/v1/nodes/:id/clocks` — live per-GPU clocks + application clock
  cap via the agent (`nvidia-smi` query) plus the CPU policy state:
  `{gpus: [{index, name, smMHz, smMaxMHz, memMHz, memMaxMHz, smCapMHz}],
  cpu: {capMHz, policies: [{cpus, minKHz, maxKHz, curMaxKHz}]} | null}`.
  `cpu: null` means the platform exposes no cpufreq policies; the key being
  **absent** means the agent predates IRI-124. The UI says "update the agent"
  for the latter and "no cpufreq on this node" for the former. `smCapMHz` is
  null on GB10: the driver does not accept `clocks.applications.sm` as a query
  field, so the desired cap lives on the node row (`gpuClockCapMHz`) and the
  live read is best-effort. `504` when the agent is offline or does not answer
  within 8 s; `502` carries the tool error.
- `POST /api/v1/nodes/:id/clocks`
  (`{smMaxMHz?: number | null, cpuMaxMHz?: number | null}`) —
  one-shot apply: `nvidia-smi -lgc 0,<max>` for the GPU and
  `min(cap, cpuinfo_max_freq)` per cpufreq policy for the CPU. An **absent**
  field leaves that side alone (a CPU-only call never resets the GPU cap);
  `null` resets it; at least one field is required. `persist` is ignored here —
  boot-time state belongs to `PUT …/clock-cap`, which records it on the node.
  Answers `{gpus, cpu, results}` with a fresh reading, `200` only when every
  requested side applied. Audited (`node.clocks.post`). Requires the root
  agent.

## Agent onboarding & updates (IRI-011/012, ADR-0007)

- `GET /install-agent.sh`, `GET /irori-agent.service`,
  `GET /agent/irori-agent.mjs` serve the repo copies of the installer, unit
  and bundle; `503 {error: "agent artifacts not available"}` when the server
  has none resolved (env `IRORI_AGENT_ARTIFACTS_DIR` in containers, monorepo
  layout in dev). No secrets are embedded — the token is supplied by the
  operator at run time. Work while degraded.
- `GET /api/v1/version` → `{version}` — the hub's own version, the drift
  reference for the UI badges and the update target. Includes `tag` when the
  image carries one and `cadenceMs` (the active snapshot cadence) on newer
  hubs.
- `POST /api/v1/nodes/:id/agent-update` dispatches an `agent-update` job
  (params `{expectedVersion: hubVersion}`) → `202 {job}`. Refusals: `400`
  malformed id, `404` unknown node, `409` when the agent predates
  `AGENT_UPDATE_MIN_VERSION` (it cannot self-update — use the install
  one-liner once), `409` while the node has an active job or a running
  bench, `409` when the agent is unreachable. A `409` for a
  starting/running/stopping setup applies only to agents that did not
  report the `scopeIsolation` hello capability (ADR-0017) — scope-wrapped
  agents isolate setups in their own cgroup and survive the restart; the
  agent still refuses the job itself if any running setup is not
  scope-wrapped.
- The agent fetches the bundle from the hub (URL derived from its own
  `IRORI_SERVER_URL`), validates it with `node --check`, keeps the previous
  bundle as `.bak` and restarts. Pre-restart failures settle via the normal
  `job-done` path; the restart itself severs the socket, so success is
  settled **on the node's next hello** — a reported version at or newer
  than `expectedVersion` flips the job to `succeeded`; an older report
  leaves it running (a blip-reconnecting old agent must not fail an
  in-flight update).
- `reapOffline` skips `agent-update` rows younger than 10 minutes and fails
  older ones with a `.bak`/journalctl rollback hint; the rule lives in the
  existing reaper loop, so it survives server restarts. No new tables.

## Jobs and benches

- `POST /api/v1/nodes/:id/jobs` and `POST /api/v1/bench/:type` return `409`
  when the node already has a queued/running job or a running bench. The
  invariant is enforced by partial unique indexes in Postgres, so concurrent
  requests get a deterministic `409` (not a race outcome); the second request
  never reaches the agent.
- Bench configs are parsed server-side and the `host` field is pinned to
  `127.0.0.1`: a bench always runs against the node-local engine, and a
  client-supplied host is ignored (the agent must never become a network
  probe). The stored `config` reflects the parsed, defaulted values.
- Terminal `job-done`/`bench-done` frames are durable: the agent replays them
  after a reconnect and the server retries the DB write through its bounded
  buffer, so the one-active slot is released even across a blip or server
  restart.
- The bench offline reaper never overwrites a terminal result with
  `failed: node went offline` (its update is status-guarded).

## Setups

- Setup worker validation: `POST /api/v1/setups` and `PATCH /api/v1/setups/:id`
  reject worker lists containing duplicate node ids, unknown ids, the head
  itself, or a NAS node → `400` with the reason. The wizard filters NAS
  candidates client-side too.
- `POST /api/v1/setups/:id/start` refuses (409) when the setup resolves
  `MODEL_PATH` and the model is not staged on the head's local store — stage
  transfers first; the agent-side `modelctl path --local` refusal would only
  leave a failed run row behind.
- **Serve execution user** (IRI-045, ADR-0015): the head agent runs a setup's
  start and stop scripts as the head node's `cacheUser` when one is set —
  ADR-0011 `runuser` shape, scrubbed `XDG_STATE_HOME`/`HF_HOME`/`HF_HUB_CACHE`,
  the owner's `HOME`/`USER`/`LOGNAME`, ambient `PATH`. A cache user without a
  passwd entry refuses the start (actionable error, never a root fallback);
  the run context persists so a stop after an agent restart keeps it. Without
  a cache user scripts run as the agent user with a `HOME` fallback (the
  systemd unit is HOME-less). The cache user needs GPU device access and read
  access to the model paths.
- Identical driver-state replies are not re-announced: an unchanged
  `(status, health, lastError)` produces no `setup-state` SSE event and no row
  write, so the driver-truth poll cannot flood the event feed.
- **Poll truth defers to the probe** (IR-151): a driver-truth poll reporting
  `stopped` (`exitCode` null) does NOT demote a row whose head node's probe
  still sees the declared engine answering the declared port — the row stays
  (or returns to) `running`/`healthy`, or `foreign` when a different engine
  answers. A daemonizing recipe (`docker run -d`, script exits 0) leaves the
  engine outside the recorded process group, so pgid-only truth would demote a
  serving engine forever. Only when nothing answers does the poll demote. A
  stop that settled within the last 30 s always demotes (the node's probe may
  still hold the pre-kill snapshot).
- **One live setup per head port** (IR-155): `POST /api/v1/setups` and
  `PATCH /api/v1/setups/:id` reject (`400`, `SetupInvalidError`) a head/port pair
  already held by a `starting|running|stopping` setup, naming the holder;
  `POST /api/v1/setups/:id/start` refuses the same situation with `409` for rows
  that predate the guard. Two setups on one port cannot both bind it, and the
  probe cannot say which of them started the engine — the sibling that never
  started used to read the live engine as its own (a phantom `running/healthy`
  row whose Stop then ran the shared script pair against the real engine). The
  wizard warns at the port field before saving.
- **Probe truth attributes the port to one row** (IR-155): the IR-151
  promotion/demotion rules above apply only to the row that owns
  `(headNodeId, port)` — a row that never started, or one whose live sibling
  started more recently, is never promoted by the probe and is reported
  `stopped` with the owning setup named. A sibling's live engine is not evidence
  that this row is serving.
- **The agent releases a leaked capture proxy** (IR-156): when a daemonized run's
  driver is gone (no child, dead group) and nothing answers its engine port
  after the warmup window with the run log idle, the driver closes the proxy and
  drops the record on its status poll. Before this, the listener stayed bound
  forever after such an engine died — the port was occupied (the recipe's own
  restart failed with "port already in use") until a Stop was issued.
- `POST /api/v1/setups/:id/stop` forwards the stop frame **regardless of row
  status** (IR-151) — no silent no-op for a `stopped` row. The agent answers
  harmlessly when its driver holds no record (that nack settles clean,
  `lastError` untouched); with a retained record it runs the stop script and
  kills the real engine. `SetupOfflineError` still applies. The Serve card
  renders Stop for a stopped row whenever the head's probe sees the declared
  engine on the declared port **and that row has started at least once** (IR-155)
  — a sibling that never ran cannot own the engine, so it shows neither the
  `serving :PORT` chip nor Stop.
- Setup frames (`setup-ack`, `setup-event`, `setup-log`) are accepted only
  from the setup's head node; `setup-validate-result` only from the node the
  validation was sent to. Frames from any other authenticated agent are
  ignored.
- Transfer recovery re-runs a stage that was persisted `running` when the
  server died — a resumed transfer never reports `succeeded` with a stage
  that never executed.
