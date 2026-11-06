# Task: IRI-128 — NAS has no LLM surface (IR-192)

Jira **IR-192** (Bug, Medium). Regression from IR-152 (`e796ac3`).

## Objective

The Serve page polled `GET /api/v1/nodes/<nas>/llm` every 2.5 s and got a
permanent 404, filling the browser console. The NAS (`kind: nas`,
`role: standalone`, `llmPorts: []`) never probes LLM ports, so the ring and the
DB fallback are always empty.

IR-152 changed `ServeView.probeNodeIds()` from setup heads to every registry
node; a NAS is never a head. `GET /llm/history` for the same node already
returns `200 {series: []}` — the live endpoint was the odd one.

## Acceptance criteria

- [x] `GET /api/v1/nodes/:id/llm` returns `200 {ports: [], updatedAt: null}`
      for `kind: nas` when no data exists; 404 stays for spark/gpu-host with
      no data.
- [x] The web probes only nodes that can serve (`kind !== "nas" && online`);
      NodeDetail skips the `/llm` fetch for a NAS.
- [x] `docs/API.md` documents the endpoint and the NAS rule.
- [x] Tests: NAS → 200 empty, spark with no data → 404, probe list filter.

## Scope

- `apps/server/src/app.ts`: the `/llm` route.
- `apps/web/src/serve.ts`: `probeableNodeIds()` (pure, testable).
- `apps/web/src/components/ServeView.vue`, `NodeDetail.vue`.
- `apps/server/test/llm.test.ts`, `apps/web/test/serve.test.ts`, `docs/API.md`.

## Verification

- Server + web tests.
- Live: Serve console has no 404 for the NAS; a spark node with no probe data
  still 404s.
