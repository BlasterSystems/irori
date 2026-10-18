# Task: IRI-004 — M3 Inference monitoring

Epic: Irori v1 ([docs/PLAN.md](../docs/PLAN.md) M3)

## Objective

Live inference state on the primary surface: backend detection, decode/prefill
rates, queue, KV cache, TTFT p95, loaded model — and the **cluster view**
grouping a head and its workers.

## Acceptance criteria

- [ ] Backend auto-detection on configured LLM ports: vLLM, llama.cpp, SGLang,
      EXL3, TensorFold, q27, LM Studio, Ollama, ds4-server.
- [ ] Live decode/prefill tok/s; queue running/waiting; KV cache; TTFT/E2E/ITL
      p95 from engine `/metrics` where published.
- [ ] Head card (primary): serving model, decode + prefill rates, queue
      run/total. Worker detection-only probes at 10 s cadence (loaded model id
      on worker cards).
- [ ] Cluster view: head + workers grouped; per-node drill-down one click away.
- [ ] Multiple LLM ports per node supported (independent panels).

## Scope

### Included

- `GET /api/v1/nodes/:id/llm`, cluster resolution from recipes' `NNODES`/
  `WORKER_IP` declarations and node roles.

### Excluded

- Inference gateway/proxy + request traces (deferred, SPEC §14).

## Plan

- [ ] Research brief: per-backend counter endpoints (port fixtures from the
      four source projects' probe tests).
- [ ] Agent probe module → snapshot `llm[]` → SSE → head card + cluster view.
- [ ] Fixture-based detection tests per backend; live smoke on one engine.

## Architecture impact

- **ADR required:** No.
- **Relevant ADRs:** 0003 (probes via agent), 0006 (streaming).
- **Proposed ADR:** None.

## Validation evidence

- 2026-10-18: full build green; tests: core 9/9, agent 61/61 (24 llm-probe:
  detection per backend over real `node:http` fixture servers with verbatim
  sparkControl fixture bodies, counter-diff seed→diff, spec-noise guard,
  SGLang sticky lifecycle, detectOnly shape, 3-failure reset, TTL re-detect,
  multi-port independence, `+Inf == _count` rejection), server 62/62
  **db-backed** (bucket math per (node,port), idempotency, watermark,
  history + raw fallback, routes, PUT llm-ports → config-update
  end-to-end), web 96/96 (llm-data shaping, per-port panel guards,
  grouping, api/live/parse). Research brief:
  `docs/research/IRI-004-research-brief.md` (probe semantics from
  sparkControl/sparkDash production code + fixtures).
- **Live soak against the real engine** — dgx1.lan:8081
  (TensorFold CUDA 0.6+, GLM-5.3-Flash-EXL3) probed by the Mac agent via
  `IRORI_LLM_TARGETS`: `/api/v1/nodes/:id/llm` → backend `tensorfold`,
  detected, model `GLM-5.3-Flash-EXL3`, kvCachePct 42.6 (pool
  4,591,616 / free 2,635,776), `streams{decoding:0, prefilling:0, max:8}`,
  queueWaiting null (not published → correct "not detected"), idle rates 0
  (counter-diff semantics). After one rollup cycle, llm history served
  minute buckets (18 samples) with real traffic (decode 28.9 tok/s,
  prefill 24.6). UI: node-detail Inference section renders the per-port
  panel (backend chip, barrows, engineMeta kv rows) from live SSE data.
- Worker detection-only mode verified in tests (config-update
  `llmDetectOnly` + 10 s cadence + window-untouched proof).
- Cluster view: role-based grouping (heads → workers → standalone);
  recipe-declared cluster resolution lands with M5 per task scope.
- SSH fallback: shapes transport-independent by construction (packages/core).
- `.agentic/bin/validate` + `.agentic/bin/docs-check` green; CI green on push.

## Review

- (pending)
