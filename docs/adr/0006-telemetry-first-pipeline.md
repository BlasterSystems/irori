# ADR-0006: Telemetry-first pipeline (agent push → rings/rollups → SSE)

- **Status:** Proposed
- **Date:** 2026-10-16
- **Decision owners:** operator
- **Scope:** Data collection, streaming, storage, and live-update architecture
- **Tags:** telemetry, sse, websocket, rollups, architecture
- **Supersedes:** None
- **Superseded by:** None

## Context

"Telemetry, data collection & streaming need to be 1st class citizens" — the
platform's primary object is the live serving state of a cluster, and the
analytics section is built from historical buckets. Source projects proved two
patterns: sparkDash's headless poll loops (rates stay correct with no browser
attached) and sparkControl's agent push with transport parity. Browsers need
live updates; the DB must not grow unbounded; the event loop must survive
10 nodes × 2 s snapshots.

## Decision drivers

- Collection independent of any browser session.
- One snapshot contract regardless of transport (agent WS vs SSH fallback).
- Bounded storage: raw ring + deterministic rollups + prune.
- Browser live updates without WebSocket-in-browser complexity.

## Considered options

### Option 1: Agent push → server rings/rollups → SSE fan-out (chosen)

Agents push versioned snapshots on a server-configured cadence (default 2 s).
The server validates against `packages/core` schemas, updates in-memory rings,
writes recent raw snapshots (bounded), and maintains minute→hour→day rollup
tables (Drizzle migrations, prune job). Browsers subscribe to
`GET /api/v1/events` (SSE) for snapshot/serve-log/job/bench events. Poll loops
run headless; SSE reconnects natively.

### Option 2: Browser WebSocket everywhere

Lower latency than SSE, but reconnect/auth complexity in-browser and proxy
fragility (uptime-monitoring deliberately chose SSE for the same reasons).

### Option 3: Store everything raw, aggregate on read

Simplest writer, but analytics over days of 2 s snapshots is unusable without
precomputed buckets regardless of engine.

## Decision

Option 1. Invariants:

- Snapshots carry `schemaVersion` + `agentVersion`; hello negotiates.
- In-memory ring (per node, e.g. 900 points) is the live-view source; DB is
  the history source; rollup jobs are idempotent and watermark-guarded.
- Serving logs and job output are telemetry events too: streamed via the same
  hub, persisted with run records (ring + compressed run log).
- Backpressure: agents buffer on disconnect and resume (last-seen cursor);
  the server never blocks ingest on slow SSE clients.

## Consequences

### Positive

- Correct rate metrics with zero clients; bounded disk; analytics reads hit
  precomputed buckets.
- One event hub serves live UI, logs, and job tails uniformly.

### Negative

- Rollup code paths need tests (watermarks, clock jumps).
- SSE is one-way — client actions stay REST (acceptable).

### Risks and mitigations

- Clock jumps on nodes → monotonic server receive-time is the bucket key;
  agent timestamps are advisory.
- Snapshot schema drift → version gate + tolerant readers; CI contract tests.

## Implementation and validation

M2 delivers ingest/rings/rollups/SSE; M3/M5/M6 add their event types.
Validation: fake-timer rollup tests, disconnect/reconnect resume test,
two-node parallel streaming soak in the M2 exit check.

## Revisit triggers

- > ~20 nodes or sub-second cadence needs (batch ingest, then consider WS
  fan-in).

## References

- SPEC §4, §7, §9; PLAN M2/M3; ADR-0002 (retention), ADR-0003 (transport).
- `uptime-monitoring/docs/adr/0003` (SSE-first rationale).
