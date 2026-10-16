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

- (pending)

## Review

- (pending)
