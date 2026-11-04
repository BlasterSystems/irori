# Task: Agent size-bounded usage batching + oversize quarantine (IR-178 / IRI-085)

## Objective

The agent must never serialize a usage batch (or a single event) whose WS
frame can exceed the hub's frame cap — the root cause of the IR-176 incident
(482 dev-hub restarts on 2026-11-04). Batches are bounded by serialized size;
a single event that alone exceeds the hard cap is quarantined instead of
retrying forever.

## Product manager summary

- **One-liner:** Agent packs usage batches to a byte target, quarantines
  monster events, and halves the batch on a 1009 close.
- **User value:** Fleet telemetry keeps flowing under heavy capture traffic;
  no node can wedge its own usage buffer or kill the hub.
- **Business impact:** Cost-analytics data preserved; no ops firefights.
- **Success metric:** A buffer holding a 70 MB event quarantines it and
  drains the rest; batches never exceed the frame cap.
- **Dependencies & constraints:** IR-176 (root cause), IRI-070 (quarantine
  flow), packages/core MAX_USAGE_FRAME_BYTES / MAX_USAGE_BATCH. Agent bundle
  rollout is owner-gated (agent restart stops supervised setups) — this
  change ships in main and rolls out with the next owner-approved
  agent-update; the hub-side hotfix (IR-177) keeps the fleet healthy until
  then.

## Acceptance criteria

- [x] Batch packing is size-bounded (target ≤ 24 MB serialized) and keeps
      MAX_USAGE_BATCH=500 count cap.
- [x] A single event serialized over the hard cap (~56 MB) is quarantined
      (reason 'oversized', metadata kept, body parts dropped) and the rest of
      the buffer drains.
- [x] A 30 MB batch splits into under-cap frames.
- [x] On close 1009 / frame-too-large, the agent halves the current batch and
      retries instead of resending the same batch forever.
- [x] Unit + db-gated tests cover quarantine, splitting, and halve-retry.

## Scope

### Included

- apps/agent/src/usage-sync.ts batching/size logic and retry handling.
- apps/agent/src/config.ts tunables if needed.
- Tests in apps/agent/test/.

### Excluded

- Hub-side behavior (IR-177 done; IR-179 storm rule).
- Fleet agent rollout (owner-gated).
- Capture-proxy payload truncation policy (open question in IR-176 doc).

## Plan

- [x] Understand requirements and inspect relevant code
- [x] Confirm architecture impact
- [x] Implement the smallest complete change
- [x] Add or update tests
- [x] Update documentation
- [x] Run validation

## Validation evidence (2026-11-04)

- Found and fixed the actual budget bug: the old math counted **gz** bytes
  (the wire carries base64, 4/3× larger) and skipped the budget check for
  the first packed event, and rows without parts never touched the budget —
  exactly the DGX-1 count-overflow shape (500 × 130 KB plain bodies).
  Budget now applies to every row's full serialized size.
- `apps/agent/test/usage.test.ts` — new "IR-178 size bounding" block:
  60 MB event quarantined (reason/meta/bytes asserted via SQLite) while the
  buffer drains; 4×4 MB rows split [2,2] under a 10 MB budget; 1009-driven
  halving produces takes [8,4,2,6] then drains. Suite: agent 247/247.
- Gates: `pnpm -r build` clean; server 366/366, web 458/458, core 102/102;
  `.agentic/bin/validate` passed; docs-check heuristic warnings only
  (CHANGELOG.md updated instead).

## Residual risks

- The quarantine table is node-local and unexposed in the UI for now —
  `quarantinedCount()`/SQLite read is the inspection path (same debug
  recipe as the IR-176 incident).
- Fleet agents run 0.3.0 bundles without this fix until the owner-gated
  agent-update; the hub-side hotfix (IR-177, 256 MB dev cap) keeps them
  draining meanwhile.

## Architecture impact

No — transport hardening within the existing agent↔hub contract (frames stay
smaller than today's allowance; protocol shapes unchanged). No ADR; the
incident research doc `tasks/research-agent-ws-oversized-frame-crash-loop.md`
carries the rationale.
