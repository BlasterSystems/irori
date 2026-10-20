# ADR-0008: Capture-proxy usage telemetry (in-agent proxy → node SQLite buffer → batched WS → Postgres)

- **Status:** Accepted
- **Accepted:** 2026-10-20 — owner approval in the M8 planning session (after adversarial review; blocking findings on rollup keying and PORT handoff fixed)
- **Date:** 2026-10-20
- **Decision owners:** operator
- **Scope:** Usage capture architecture, node-side buffer, sync transport, storage, retention, security posture of the new listener
- **Tags:** usage, proxy, capture, agent, websocket, postgres, sqlite, retention, security
- **Supersedes:** None
- **Superseded by:** None

> This ADR amends ADR-0003's inbound-port posture and reconciles ADR-0002's
> storage claim — neither is superseded (see Context and Decision).

## Context

M8 turns Irori into the capture point between LLM clients and local engines
(IRI-009, research brief `docs/research/IRI-009-research-brief.md`). The wire
probe (2026-10-17) proved an OpenAI-compatible pass-through proxy sees
everything a client-side harness logs — plus engine-internal metrics the
TensorFold final chunk reports (`prefill_s`/`decode_s`/speculative-decoding
drafted/accepted) — for **every** client with zero cooperation. Owner
decisions (2026-10-17): 90 d raw retention (1 y rollups), node-local SQLite
WAL buffer + batched WS sync into Postgres, proxy lives **in the agent** as
extractable `packages/proxy`, opt-in per setup, no gateway features (no
routing/fallbacks/auth). Costs/providers/frustration are cut; body retention
and attribution are phase-2 (IR-51).

This is the first **inbound network listener** on the agent, and it runs
**as root** (ADR-0003). ADR-0003 established "outbound-only WS, no inbound
ports" as the trust model; this ADR amends it for one purpose-bounded
listener.

## Decision drivers

- Capture must be invisible to traffic: streaming byte-identical, capture
  failure never affects a request.
- Survive WS outages and agent restarts with zero loss and zero duplicates.
- Protect pgsql: batched multi-row inserts (owner decision), not per-request.
- The agent is root (ADR-0003): the listener must not widen what a malicious
  client can reach beyond what an engine bound to the LAN already exposes.
- v1 wire fields only; no request/response body retention.

## Considered options

### Option 1: In-agent capture proxy + node SQLite buffer + batched WS sync (chosen)

`packages/proxy` runs inside the existing root agent. A flagged setup binds
the engine to loopback (via the documented `$PORT` env contract) and the agent
publishes the setup's declared LAN port; the proxy forwards to
`127.0.0.1:<enginePort>` and records per-request events. Events land in a
node-local SQLite (WAL) buffer; a 30–60 s batcher uploads ≤500 events per
frame over the existing outbound WS; the server inserts with
`ON CONFLICT (id) DO NOTHING` and acks, the agent deletes acked rows. UUID
primary keys make redelivery after a lost ack idempotent.

### Option 2: Central gateway on the server host

All nodes' traffic would traverse a proxy in the server container. Rejected:
adds a hop outside the serving node (latency, new failure domain), requires
the server to reach into node networking, and contradicts the homelab
topology (engine traffic stays on the serving node; only telemetry leaves).

### Option 3: Client/harness-side logging (OMP-stats pattern)

The client is the sensor (OMP's architecture). Rejected: covers only
cooperating clients, misses engine-internal metrics, and a fleet platform
cannot require every client to opt in.

### Option 4: Agent captures via eBPF/pcap wire tap

No cooperation needed without a proxy hop. Rejected: root complexity,
TLS-blind, platform-specific, and far outside a boring homelab dependency
set.

## Decision

Option 1, with these invariants:

1. **Raw byte pipe, passive tee.** The proxy is not an HTTP-aware gateway: it
   forwards the request-target, headers, and body **verbatim** (hop-by-hop
   headers re-framed by the transport, nothing reinterpreted) and observes a
   capped, size-bounded tee for capture. Malformed or smuggled requests reach
   the engine byte-identically — exactly as when the engine bound the port
   directly — and can only confuse capture, never the engine. The upstream
   target is fixed at spawn (`127.0.0.1:<enginePort>`); CONNECT and
   absolute-URI routing are never interpreted.
2. **Capture is fail-open and selective.** Every capture step (body parse,
   SSE parse, buffer insert) is best-effort; a capture error logs and
   continues. Events are emitted only for OpenAI-compat inference requests
   (POST with a parseable OpenAI body: `/v1/chat/completions`,
   `/v1/completions`, `/v1/embeddings`, `/v1/responses`). Detection/metrics
   probes (`/metrics`, `/health`, `/v1/models`, `/slots`, …) are forwarded
   uncaptured — the agent probes the proxied port every 2 s and would
   otherwise flood `llm_requests` with ~40 k noise rows/day/port.
3. **Durable node buffer, expendable by design.** Node-local SQLite (Node 24
   built-in `node:sqlite`, WAL mode) in the agent state dir. Insert on
   capture, delete on server ack, prune/cap-drop ordered by **buffer insert
   time** (local, skew-immune — not request timestamp). Cap-drop may discard
   unacked rows (accepted tradeoff under a prolonged outage); redelivery is
   idempotent, so exactly-once otherwise holds. This reconciles ADR-0002
   ("PostgreSQL is the only store"): the SQLite file is a transient node-local
   buffer per the owner decision — never a system of record, never backed up.
4. **Exactly-once into Postgres.** Client-generated UUID v4 primary keys;
   server inserts per batch with `ON CONFLICT DO NOTHING`; ack carries the
   ids. A crash between insert and ack is safe (redelivery is a no-op). The
   batch + ack frames are new `packages/core` schema variants (ADR-0006
   validated contracts) wired into both the hub router and the agent
   transport.
5. **Rollups keyed on server ingest time**, consistent with ADR-0006/0002
   ("agent timestamps are advisory"): `usage_buckets` bucket on the server's
   receive time so replayed rows land inside the watermark recompute window —
   keying on request time would permanently lose buckets for data replayed
   after a WS outage. Request `ts` is stored on the raw row and shown in the
   UI.
6. **Retention mirrors ADR-0002/0006 conventions.** Hourly/daily
   `usage_buckets` (watermark-guarded upserts), raw `llm_requests` pruned at
   90 d, rollups at 1 y, in the existing prune loop.
7. **Opt-in per setup, explicit PORT handoff.** Unflagged setups are
   unchanged (no env changes, no listener). For flagged setups the server
   **omits** `PORT` from the start env (it cannot know a node-local free
   port); the agent picks a free loopback port and injects
   `PORT=<enginePort>` at spawn — same pattern as `MODEL_PATH`, resolved
   agent-side in `SetupDriver`. Scripts **must honor `$PORT`**: the M8 wizard
   adds a capture checkbox whose review copy states this and pre-fills
   `EXTRA_ARGS` with a loopback-bind hint. The listener binds `0.0.0.0`/`::`
   (not the LAN IP) so probes and clients reach it via any local address;
   `setups.port` stays the client-facing and probed port. The listener is
   closed when the setup stops — a stopped-but-flagged setup leaves no
   forwarder to a dead port.
8. **Root-privilege consequence, stated.** The parser executes as root
   (ADR-0003 "high-value target"): this is why the tee is passive and capped
   (bounded header block, bounded capture body, bounded SSE re-assembly) and
   why nothing parsed ever feeds the forwarding path.

## Consequences

### Positive

- All clients, zero cooperation; richer per-request data than harness logging
  (TensorFold block, wire-level TTFT, payload sizes, source address).
- pgsql load stays a batched insert per interval per node; node outage costs
  nothing (buffer replays).
- The capture proxy is extractable: `packages/proxy` has no agent imports.

### Negative

- The agent process gains a listener and an extra state file to manage.
- Requests are captured only when routed through a flagged setup's proxy;
  traffic aimed directly at a loopback/worker engine port is invisible (v1
  scope: setup port is the client-facing port).
- `node:sqlite` is flagged experimental (stability 1.2 release candidate as of
  Node v24.15.0): a warning logs at first use.
- Bucket keys use server receive time, so a request's bucket can differ from
  its wall-clock time by the sync delay (≤ batch interval + outage length).

### Risks and mitigations

- **Malicious LAN client vs root proxy** → no eval/injection surface: the
  forwarding path parses nothing (raw bytes), capture parsing is best-effort
  into a fixed schema, caps bound all buffers, capture exceptions cannot
  touch forwarding.
- **Proxy port squatting / engine on wrong port** → proxy binds before spawn;
  engine bind failure surfaces in streamed logs, health goes `timeout`.
- **Buffer flood** (offline node, runaway traffic) → row cap drops oldest by
  insert time, 90 d prune; sync is resumable by design.
- **SSE flood to browsers** at high request rates → usage events share the
  existing hub; feed ring is capped; homelab scale.

## Implementation and validation

M8 (IRI-009): `packages/proxy` with mock-engine fixture tests (streaming
byte-identity, capture correctness, failure isolation); agent buffer + sync
tests including WS-outage replay; server ingest dedup + rollup + retention
tests; the four usage endpoints contract-tested; live smoke: mock engine →
proxy → buffer → sync → API → UI, plus kill-the-WS replay. Exit: live traffic
through a flagged setup populates all four Usage pages.

## Revisit triggers

- A second node needs to serve proxied traffic for a setup hosted elsewhere.
- Phase-2 (IR-51) body retention changes the buffer format/retention story.
- `node:sqlite` breaks on a Node upgrade: `install-agent.sh` already provisions
  and pins Node 24 under `/opt/irori/node`; swap to a bundled SQLite if the
  API is removed.

## References

- Research brief `docs/research/IRI-009-research-brief.md` (wire probe §3,
  owner decisions §6).
- PLAN.md M8; task `tasks/IRI-009-m8-usage-capture-telemetry.md`; phase 2:
  IR-51.
- ADR-0002 (storage/retention — buffer reconciliation), ADR-0003 (agent trust
  model — inbound-port amendment), ADR-0006 (telemetry pipeline/rollups —
  ingest-time bucketing).
