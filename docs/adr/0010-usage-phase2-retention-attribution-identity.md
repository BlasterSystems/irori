# ADR-0010: Usage phase 2 — body retention, chats reconstruction, tool attribution, client identity

- **Status:** Proposed
- **Date:** 2026-10-21
- **Decision owners:** operator
- **Scope:** Usage capture phase 2 (IR-51 epic): body storage model, session reconstruction, tool attribution, client identity; extends the ADR-0008 capture pipeline additively
- **Tags:** usage, proxy, capture, retention, privacy, postgres, attribution, identity
- **Supersedes:** None
- **Superseded by:** None

## Context

M8 (ADR-0008) ships native wire fields only; body retention and attribution
were explicitly deferred to phase 2 (IR-51) and are the ADR's named revisit
trigger. Phase 2 = IR-52 (payload retention), IR-53 (chats), IR-54 (tool
attribution), IR-55 (client identity). Every OpenAI-compatible request body is
a full conversation snapshot, images arrive as base64 data URLs (byte-exact),
tool results are verbatim `role:"tool"` messages, and the TensorFold final
chunk carries engine-computed prompt hashes — reconstruction and attribution
are therefore possible purely from proxy-side capture. Caveat (accepted):
reconstruction yields exactly what the model saw; harness-side truncation is
visible as such and original binaries are not recoverable.

## Decision drivers

- Storing bodies is a privacy-sensitive escalation: the agent runs as root
  (ADR-0003) and would persist prompt/response content, including whatever
  clients send. Must be opt-in per setup, default off, visibly labeled.
- pgsql load stays bounded (ADR-0002/0008): bodies repeat heavily across turns
  (every turn re-sends history); dedupe must make growth sublinear.
- Node buffers are expendable (ADR-0008 §3): bodies must survive the same
  outage/replay semantics without multiplying buffer size.
- Wire capture is fail-open and passive; nothing parsed may affect forwarding.
- No gateway features (ADR-0008): client identity must not become auth —
  identification only, homelab trust model (SPEC §12).

## Considered options

### Option 1 — whole-body blobs keyed per request

Store each request/response as one gzip blob. Rejected: zero dedupe across
turns (bodies grow monotonically → O(n²) storage over a session), no
sublinear guarantee, buffer bloat.

### Option 2 — message-level content-addressed parts (chosen)

Decompose chat bodies into canonical-JSON parts (one per message; `prompt`/
`input` bodies as a single part), sha256-address the uncompressed canonical
bytes, store gzip blobs once, reference them from per-request join rows with
ordinal + role + kind. Response is re-assembled from the wire (streamed deltas
or the non-streamed `message`) into one `response` part; 4xx bodies become
`error` parts.

### Option 3 — server-side decomposition from raw forwarded bodies

The agent ships whole gzipped bodies; the server decomposes. Rejected: the
node buffer would store undeduplicated bodies (defeats §3), and ingest
parsing of untrusted bytes on the hub widens the attack surface the proxy
was designed to avoid.

## Decision

Option 2, with these invariants:

1. **Storage model (IR-52).** `llm_parts(hash PK, bytes, gz bytea, truncated,
   refcount, created_at)` + `llm_request_parts(request_id, ordinal, hash,
   kind, role, bytes, truncated)`. Kinds: `message|prompt|input|response|
   error|marker`. `hash` = sha256 of the canonical (uncompressed) content —
   truncated parts hash the truncation-wrapper bytes they actually store, so
   hash always addresses stored bytes. `bytes` always records the ORIGINAL
   length. Global caps live in the `usage_body_retention` settings key
   (defaults 16 MiB body / 4 MiB part); the per-setup `bodyRetention` flag
   (default off) is delivered to the agent in the setup-start `capture`
   payload; caps take effect on next setup start/restart.
2. **Truncation is explicit and ordinal-safe.** Oversize parts are cut into a
   UTF-8-safe JSON wrapper (`{irori_truncated, original_bytes, prefix}`) so
   stored bytes always parse. Body-cap omissions emit `marker` parts
   (`{irori_body_truncated, omitted_messages, omitted_bytes}`) at the position
   of the omission — reconstruction order stays faithful. A part limit
   (8192) folds overflow into the tail marker.
3. **Refcounting is exactly-once.** Parts are ingested only for rows newly
   inserted by `ON CONFLICT DO NOTHING` — redelivered events never touch
   refcounts. Ingest upserts `refcount = refcount + excluded.refcount` with
   per-hash aggregation (no same-statement duplicate conflict). `pruneRaw`
   deletes requests, releases their references, and drops zero-ref parts in
   one statement; parts die with their owning rows (90 d raw retention).
4. **Node buffer mirrors the model (IR-52).** `pending_parts` in the agent's
   SQLite (hash PK, gz BLOB, refcounted by referencing rows); pending rows
   carry only part metadata + a hash list — body bytes are stored once.
   Batches re-attach gz at send time under a budget on the ATTACHED base64
   sizes (48 MiB against the hub's 64 MiB WS receive limit
   `MAX_USAGE_FRAME_BYTES`); a single worst-case event (16 MiB body + 2×4 MiB
   response/error caps, incompressible ≈ 32 MiB base64) fits both, so a
   singleton always travels and no frame can poison the connection. Ack
   removes rows and releases refs; age/cap prune does the same; the parts
   store itself is byte-capped (256 MiB, oldest unreferenced evicted).
   Buffer mutations are transactional (BEGIN IMMEDIATE) so a crash cannot
   strand refcounts. Cap-drop may orphan content server-side
   (reconstruction shows a gap) — accepted, matching ADR-0008 §3 expendable
   buffers. gzipSync runs on the agent main loop; caps bound the worst-case
   block (≈ tens of ms at default caps, homelab scale).
5. **Browsers never receive body bytes.** SSE `usage` frames and the requests
   API carry gz-free part metadata (`usagePartMetaSchema`); bytes are served
   only by the Chats reconstruction endpoint (IR-53).
6. **Sessions (IR-53) are computed on read.** Requests chain when the next
   request's stored part sequence extends the previous one (prefix chaining)
   within the same client identity and a time-gap window measured on the
   agent's `ts` (ingest time ties within one sync batch); a broken chain
   whose FIRST message survives the previous session's first message and
   whose input dropped by >50% marks the boundary `compacted` instead of
   splitting (OMP-style compaction — the surviving system prompt is the
   lineage signal; a different first message is a NEW conversation and
   splits even when the input dropped). Residual heuristic: a new
   conversation that begins with the byte-identical first message and
   smaller input within the gap window is absorbed as `compacted` —
   accepted without a client session signal (no `X-Irori-Session` today).
   `tensorfold.sha256`/`token_sha` remain advisory chaining signals in
   `engine_meta`. Reconstruction = last request's parts + final response
   part; sessions without stored bodies surface an "enable retention"
   empty state, never errors.
7. **Tool attribution (IR-54) is capture-time, retention-independent.**
   `tool_call` deltas are reassembled by index (id/name/args concat);
   `role:"tool"` results are lifted from request bodies at capture (bounded
   per result). Attribution at ingest: completion tokens split across a
   response's tool calls by argument-character share; prompt tokens split
   across the request's tool results by result-character share — each
   request's shares sum to its totals. Tool names resolve across rows
   (call-id ring + recent-row fallback, `unknown` otherwise). Persisted in
   `llm_request_tools` per request; the Tools view aggregates by tool × model.
8. **Client identity (IR-55) is identification, not auth.** The proxy
   fingerprints the bearer token (sha256; the raw key is never stored or
   forwarded onward beyond the original byte pipe) and reads the documented
   `X-Irori-Project`, `X-Irori-Agent-Type` (`main|subagent`), `X-Irori-Client`
   headers. The server resolves the fingerprint against server-issued client
   identities (`client_identities`: name, project, agent type, key hash;
   key returned once at creation); header values fill fields a matched
   identity does not set and stand alone when no key matches. Retry lineage
   uses a single documented header `X-Irori-Retry:
   attempt=<n>;kind=<kind>;status=<status>;superseded-by=<responseId>`.
   Unidentified clients are labeled by source IP; the requests page gains
   project/agent-type filters, a per-client Agents view aggregates raw rows
   (bucket keys stay node×model — client dims are raw-row aggregations within
   the 90 d window). No v1 view regresses.

## Consequences

### Positive

- Sublinear body growth under OMP-style full-history resends (dedupe proven
  by shared-hash refcounts); buffers stay bounded.
- Chats, tools, and agents views all derive from one additive schema; v1
  views and the capture path are unchanged when retention/identity are off.
- Body bytes reach only the Chats endpoint; live views stay light.

### Negative

- Root proxy persists sensitive content when retention is on — operator must
  opt in knowingly (UI labels it; Postgres is the only durable copy, 90 d).
- gzipSync blocks the agent event loop proportionally to part sizes (capped).
- Session chaining is heuristic (client + time + prefix/compaction signals);
  exotic client behavior can split or merge sessions.
- Header-declared identity is client-asserted, not verified (homelab trust).

### Risks and mitigations

- Secrets in bodies (retention on) → 90 d prune + explicit opt-in + part
  caps; no third-party egress anywhere in the pipeline.
- Refcount drift (crash between statements) → parts ingest is transactional
  per batch; prune's zero-ref sweep is the recovery path; drift surfaces as
  early/late part deletion, never data corruption of live rows.
- Malicious client sends crafted X-Irori-* headers → fields are bounded,
  stored as data only; they never influence forwarding or job surfaces.

## Implementation and validation

- IR-52 (PR #23): proxy retention decomposition, agent parts buffer, server
  refcounted ingest + prune, Serve wizard toggle. Suites: proxy 15 (6 new),
  agent 137 (5 new), server 135 (2 new, db-gated on real Postgres), core 61,
  web 183; build + validate green.
- IR-55 → IR-54 → IR-53 follow; each closes with fixture tests (multi-turn
  image dedupe; parallel tool-call attribution sums; compaction boundary) and
  one local end-to-end smoke (mock engine → proxy → buffer → server → UI).
- SPEC §13/§14 updated at the phase-2 wrap-up.

## Revisit triggers

- Retention defaults change (owner decision on fleet rollout).
- A second node must serve proxied traffic for a setup hosted elsewhere
  (ADR-0008 trigger — the identity/parts contracts are node-local today).
- Postgres storage pressure from parts → part-level retention shorter than
  the 90 d raw window.

## References

- IR-51 (epic), IR-52..55; `docs/research/IRI-009-research-brief.md` §4–§5.
- ADR-0008 (capture pipeline; this ADR executes its phase-2 revisit trigger),
  ADR-0002 (storage/retention), ADR-0003 (agent trust model).
