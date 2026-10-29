import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { llmPortSnapshotSchema } from "@irori/core";
import {
  LlmPortProbe,
  normalizeModelId,
  parsePromHistogram,
  parsePromText,
  promHistogramQuantile,
  promMax,
  promSum,
} from "../src/llm-probe.js";

// ─── Fixture bodies (verbatim from sparkControl probe captures) ───────────

/** sparkControl LlmProbe.vllm-llamacpp.regression.test.js — VLLM_METRICS. */
const VLLM_METRICS = `vllm:prompt_tokens_total{engine="0"} 1000.0
vllm:generation_tokens_total{engine="0"} 500.0
vllm:num_requests_running{engine="0"} 2.0
vllm:num_requests_waiting{engine="0"} 1.0
vllm:kv_cache_usage_perc{engine="0"} 0.42
vllm:num_preemptions_total{engine="0"} 3.0
vllm:prefix_cache_hits_total{engine="0"} 10.0
vllm:prefix_cache_queries_total{engine="0"} 20.0
vllm:spec_decode_num_accepted_tokens_total{engine="0"} 8.0
vllm:spec_decode_num_draft_tokens_total{engine="0"} 10.0
`;

/** sparkControl LlmProbe.histogram.test.js — SINGLE_SERIES_BODY. */
const VLLM_TTFT_HIST = `vllm:time_to_first_token_seconds_bucket{engine="0",le="0.001",model_name="m"} 0.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1",model_name="m"} 634.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.5",model_name="m"} 1749.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="1.0",model_name="m"} 2330.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="10.0",model_name="m"} 2588.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="2560.0",model_name="m"} 2644.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="m"} 2644.0
vllm:time_to_first_token_seconds_count{engine="0",model_name="m"} 2644.0
vllm:time_to_first_token_seconds_sum{engine="0",model_name="m"} 2869.0
`;

/** sparkControl LlmProbe.q27.test.js — Q27_METRICS / Q27_LIVE_METRICS. */
const Q27_METRICS = `# TYPE q27_requests_total counter
q27_requests_total{api="chat"} 3
q27_requests_total{api="messages"} 1
# TYPE q27_requests_errors_total counter
q27_requests_errors_total{api="chat"} 0
# TYPE q27_prompt_tokens_total counter
q27_prompt_tokens_total{api="chat"} 200
q27_prompt_tokens_total{api="messages"} 50
# TYPE q27_prefill_computed_tokens_total counter
q27_prefill_computed_tokens_total{api="chat"} 150
q27_prefill_computed_tokens_total{api="messages"} 50
# TYPE q27_prefill_cached_tokens_total counter
q27_prefill_cached_tokens_total{api="chat"} 50
# TYPE q27_decode_tokens_total counter
q27_decode_tokens_total{api="chat"} 400
q27_decode_tokens_total{api="messages"} 100
# TYPE q27_requests_inflight gauge
q27_requests_inflight 2
# TYPE q27_slots_total gauge
q27_slots_total 4
# TYPE q27_kv_usage_perc gauge
q27_kv_usage_perc 0.42
# TYPE q27_spec_accept_ratio gauge
q27_spec_accept_ratio 0.87
# TYPE q27_preemptions_total counter
q27_preemptions_total 0
# TYPE q27_ttft_seconds histogram
q27_ttft_seconds_bucket{api="chat",le="0.010"} 0
q27_ttft_seconds_bucket{api="chat",le="0.050"} 0
q27_ttft_seconds_bucket{api="chat",le="0.100"} 0
q27_ttft_seconds_bucket{api="chat",le="0.250"} 0
q27_ttft_seconds_bucket{api="chat",le="0.500"} 2
q27_ttft_seconds_bucket{api="chat",le="1.000"} 2
q27_ttft_seconds_bucket{api="chat",le="2.500"} 2
q27_ttft_seconds_bucket{api="chat",le="5.000"} 2
q27_ttft_seconds_bucket{api="chat",le="+Inf"} 2
q27_ttft_seconds_sum{api="chat"} 0.9
q27_ttft_seconds_count{api="chat"} 2
`;

const Q27_LIVE_METRICS = `# TYPE q27_decode_tokens_processed_total counter
q27_decode_tokens_processed_total 400
# TYPE q27_prefill_computed_tokens_processed_total counter
q27_prefill_computed_tokens_processed_total 150
# TYPE q27_prefill_cached_tokens_processed_total counter
q27_prefill_cached_tokens_processed_total 50
# TYPE q27_requests_inflight gauge
q27_requests_inflight 1
`;

/** sparkControl LlmProbe.ds4.test.js — DS4_METRICS. */
const DS4_METRICS = `# TYPE ds4_tokens_prefilled_total counter
ds4_tokens_prefilled_total{kind="computed"} 100.0
ds4_tokens_prefilled_total{kind="cached"} 300.0
# TYPE ds4_tokens_decoded_total counter
ds4_tokens_decoded_total 50.0
# TYPE ds4_decode_tok_s gauge
ds4_decode_tok_s 13.17
# TYPE ds4_prefill_tok_s gauge
ds4_prefill_tok_s 197.78
# TYPE ds4_requests_inflight gauge
ds4_requests_inflight 2
# TYPE ds4_banks_total gauge
ds4_banks_total 12
# TYPE ds4_spec_accept_ratio gauge
ds4_spec_accept_ratio 0.7736
`;

/** sparkControl LlmProbe.tensorfold.test.js — CUDA_MODELS (CUDA `tensorfold serve`). */
const CUDA_MODELS = {
  object: "list",
  data: [{ id: "Qwen3.8-Flash-Next-MLX-4bit-MTP", object: "model", owned_by: "tensorfold" }],
};

/** LM Studio GET /api/v0/models (it answers 200 on every path). */
const LMSTUDIO_MODELS = {
  object: "list",
  data: [
    {
      id: "qwen2.5-7b-instruct",
      object: "model",
      publisher: "lmstudio-community",
      owned_by: "lmstudio",
    },
  ],
};

/** SGLang Prometheus exposition (TP-rank gauges are max-variant). */
const SGLANG_METRICS = (gen: number, compute: number): string =>
  [
    `sglang:generation_tokens_total ${gen}`,
    `sglang:prompt_tokens_total 100`,
    `sglang:realtime_tokens_total{mode="prefill_compute"} ${compute}`,
    `sglang:realtime_tokens_total{mode="prefill_cache"} 9000`,
    `sglang:num_running_reqs 3`,
    "",
  ].join("\n");

// ─── Harness ──────────────────────────────────────────────────────────────

interface RouteReply {
  status?: number;
  json?: unknown;
  text?: string;
}

type Routes = Record<string, () => RouteReply | Promise<RouteReply>>;

interface FixtureServer {
  port: number;
  readonly hits: { path: string; authorization: string | null }[];
  close(): Promise<void>;
}

async function startFixture(routes: Routes): Promise<FixtureServer> {
  const hits: { path: string; authorization: string | null }[] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push({ path, authorization: req.headers.authorization ?? null });
    void (async () => {
      const handler = routes[path];
      const reply = handler !== undefined ? await handler() : { status: 404, json: {} };
      res.statusCode = reply.status ?? 200;
      if (reply.text !== undefined) {
        res.setHeader("content-type", "text/plain");
        res.end(reply.text);
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply.json ?? {}));
      }
    })();
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  const fns = teardown.reverse();
  teardown.length = 0;
  for (const fn of fns) await fn();
});

async function startTracked(routes: Routes): Promise<FixtureServer> {
  const srv = await startFixture(routes);
  teardown.push(() => srv.close());
  return srv;
}

function parseSnapshot(raw: unknown) {
  return llmPortSnapshotSchema.parse(raw);
}

// ─── vLLM ─────────────────────────────────────────────────────────────────

it("detects vLLM from /v1/models + vllm: metrics and diffs counters", async () => {
  const clock = makeClock();
  const state = { metrics: VLLM_METRICS };
  const srv = await startTracked({
    "/v1/models": () => ({
      json: { data: [{ id: "meta-llama/Llama-3.1-8B", max_model_len: 8192 }] },
    }),
    "/metrics": () => ({ text: state.metrics }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("vllm");
  expect(seed.detected).toBe(true);
  expect(seed.model).toBe("meta-llama/Llama-3.1-8B");
  expect(seed.decodeTps).toBe(0);
  expect(seed.prefillTps).toBe(0);
  expect(seed.queueRunning).toBe(2);
  expect(seed.queueWaiting).toBe(1);
  expect(seed.kvCachePct).toBe(42);
  expect(seed.ttftP95Ms).toBeNull();
  expect(seed.engineMeta).toEqual({ contextLength: 8192 });

  clock.advance(2000);
  state.metrics =
    VLLM_METRICS.replace("1000.0", "1200.0").replace("500.0", "900.0") + "\n" + VLLM_TTFT_HIST;
  const live = parseSnapshot(await probe.probe(false));
  expect(live.decodeTps).toBe(200); // Δ900−500 over 2 s
  expect(live.prefillTps).toBe(100); // Δ1200−1000 over 2 s
  expect(live.ttftP95Ms).toBeCloseTo(7341.86, 1); // p95 lands in the le=10 bucket
  expect(live.e2eP95Ms).toBeNull();
  expect(live.itlP95Ms).toBeNull();
});

it("vLLM prefill uses iteration-token surplus and ignores spec noise", async () => {
  const clock = makeClock();
  const iter = (n: number): string => `${VLLM_METRICS}vllm:iteration_tokens_total_sum{engine="0"} ${n}.0\n`;
  const state = { metrics: iter(2000) };
  const srv = await startTracked({
    "/v1/models": () => ({ json: { data: [{ id: "meta-llama/Llama-3.1-8B" }] } }),
    "/metrics": () => ({ text: state.metrics }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.decodeTps).toBe(0);
  expect(seed.prefillTps).toBe(0);

  // Δiter 480 − Δgen 400 = 80 < 50 % of decode Δ → spec noise, not prefill.
  clock.advance(2000);
  state.metrics = iter(2480).replace("1000.0", "1200.0").replace("500.0", "900.0");
  const noisy = parseSnapshot(await probe.probe(false));
  expect(noisy.decodeTps).toBe(200);
  expect(noisy.prefillTps).toBe(0);

  // Decode stops; the full iteration surplus becomes prefill.
  clock.advance(2000);
  state.metrics = iter(4480).replace("1000.0", "1200.0").replace("500.0", "900.0");
  const prefillOnly = parseSnapshot(await probe.probe(false));
  expect(prefillOnly.decodeTps).toBe(0);
  expect(prefillOnly.prefillTps).toBe(1000); // Δiter 2000 / 2 s
});

it("rejects a histogram whose +Inf bucket does not equal _count", async () => {
  const clock = makeClock();
  const broken = Q27_METRICS.replace(
    `q27_ttft_seconds_count{api="chat"} 2`,
    `q27_ttft_seconds_count{api="chat"} 1`,
  );
  const srv = await startTracked({
    "/v1/models": () => ({ json: { data: [{ id: "qwen38-27b-mtp", owned_by: "q27" }] } }),
    "/metrics": () => ({ text: broken }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });
  const snap = parseSnapshot(await probe.probe(false));
  expect(snap.ttftP95Ms).toBeNull();
});

// ─── EXL3 ─────────────────────────────────────────────────────────────────

it("detects EXL3 via the /health fall-through and gates rates on busy", async () => {
  const clock = makeClock();
  const state = {
    health: {
      ok: true,
      busy: true,
      backend: "exl3",
      prompt_tokens_total: 100,
      completion_tokens_total: 50,
      context_length: 65536,
    },
  };
  const srv = await startTracked({
    "/slots": () => ({ status: 404, json: {} }),
    "/v1/models": () => ({ json: { data: [{ id: "qwen3.8-27b-exl3-3.5bpw-wm", owned_by: "local" }] } }),
    "/metrics": () => ({ status: 404, text: "" }),
    "/server_info": () => ({ status: 404, json: {} }),
    "/health": () => ({ json: state.health }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("exl3"); // {ok,busy} health, not vllm
  expect(seed.model).toBe("qwen3.8-27b-exl3-3.5bpw-wm");
  expect(seed.decodeTps).toBe(0);
  expect(seed.prefillTps).toBe(0);
  expect(seed.queueRunning).toBe(1);
  expect(seed.engineMeta).toEqual({ busy: true, contextLength: 65536 });

  clock.advance(2000);
  state.health = { ...state.health, prompt_tokens_total: 180, completion_tokens_total: 90 };
  const live = parseSnapshot(await probe.probe(false));
  expect(live.decodeTps).toBe(20);
  expect(live.prefillTps).toBe(40);

  clock.advance(2000);
  state.health = { ...state.health, busy: false };
  const idle = parseSnapshot(await probe.probe(false));
  expect(idle.decodeTps).toBe(0);
  expect(idle.prefillTps).toBe(0);
  expect(idle.queueRunning).toBe(0);
});

// ─── TensorFold ───────────────────────────────────────────────────────────

it("detects TensorFold; live{} is used as-is; counters diff when absent", async () => {
  const clock = makeClock();
  const streams = { decoding: 1, prefilling: 0, filling: 0, paused: 0, max: 4 };
  const state = {
    health: {
      ok: true,
      busy: true,
      backend: "tensorfold",
      prompt_tokens_total: 1000,
      completion_tokens_total: 200,
      cached_tokens_total: 640,
      prefill_seconds_total: 10.0,
      context_length: 262144,
      requests_running: 2,
      pool_tokens: 100000,
      pool_free_tokens: 90000,
      streams,
    } as Record<string, unknown>,
  };
  const srv = await startTracked({
    "/v1/models": () => ({ json: CUDA_MODELS }),
    "/health": () => ({ json: state.health }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("tensorfold");
  expect(seed.model).toBe("Qwen3.8-Flash-Next-MLX-4bit-MTP");
  expect(seed.decodeTps).toBe(0);
  expect(seed.prefillTps).toBe(0);
  expect(seed.kvCachePct).toBe(10); // 1 − 90000/100000
  expect(seed.queueRunning).toBe(2);
  expect(seed.engineMeta).toEqual({
    streams,
    poolTokens: 100000,
    poolFreeTokens: 90000,
    contextLength: 262144,
  });

  // CUDA 0.6+ live block: server-computed rates pass through verbatim.
  clock.advance(2000);
  const liveBlock = {
    decode_tokens_per_second: 42.5,
    prefill_tokens_per_second: 318.7,
    connections: 1,
    waiting: 3,
  };
  state.health = { ...state.health, live: liveBlock };
  const live = parseSnapshot(await probe.probe(false));
  expect(live.decodeTps).toBe(42.5);
  expect(live.prefillTps).toBe(318.7);
  expect(live.queueWaiting).toBe(3);
  expect(live.engineMeta).toMatchObject({ live: liveBlock });

  // live{} removed → counter diffs take over with a continuous window.
  clock.advance(2000);
  state.health = {
    ...state.health,
    live: undefined,
    prompt_tokens_total: 1600,
    completion_tokens_total: 240,
    prefill_seconds_total: 10.2,
  };
  const counters = parseSnapshot(await probe.probe(false));
  expect(counters.decodeTps).toBe(20); // Δ240−200 / 2 s
  expect(counters.prefillTps).toBe(3000); // Δcomputed 600 / Δprefill_seconds 0.2

  // A cached-token jump must not inflate the computed-prefill rate.
  clock.advance(2000);
  state.health = { ...state.health, prompt_tokens_total: 1700, cached_tokens_total: 1240 };
  const cacheTurn = parseSnapshot(await probe.probe(false));
  expect(cacheTurn.prefillTps).toBe(0); // computed Δ100 − cached Δ600 < 0
});

it("detects TensorFold-native via /api/v0 owned_by; queue/KV fall back to /metrics", async () => {
  const clock = makeClock();
  const live = { connections: 1, waiting: 2, decode_tokens_per_second: 0, prefill_tokens_per_second: 0 };
  const state = {
    health: { status: "ok", model: "Qwen3.8-Flash-Next", live, version: "1.1.4", backend: "cuda" } as Record<string, unknown>,
    metrics: "tensorfold:requests_running 0\ntensorfold:kv_cache_usage_ratio{pool=\"0\"} 0.42\n",
  };
  const srv = await startTracked({
    // 1.1+ answers the LM Studio probe with owned_by: tensorfold.
    "/api/v0/models": () => ({ json: { object: "list", data: [{ id: "Qwen3.8-Flash-Next", owned_by: "tensorfold" }] } }),
    "/health": () => ({ json: state.health }),
    "/metrics": () => ({ text: state.metrics }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("tensorfold"); // not lmstudio — its applier is a no-op
  expect(seed.model).toBe("Qwen3.8-Flash-Next");
  expect(seed.decodeTps).toBe(0);
  expect(seed.queueRunning).toBe(0); // from /metrics, health has no counters
  expect(seed.queueWaiting).toBe(2); // live.waiting
  expect(seed.kvCachePct).toBe(42); // ratio 0.42 → pct

  clock.advance(2000);
  state.health = { ...state.health, live: { ...live, decode_tokens_per_second: 33.3, prefill_tokens_per_second: 120.5 } };
  const liveSnap = parseSnapshot(await probe.probe(false));
  expect(liveSnap.decodeTps).toBe(33.3);
  expect(liveSnap.prefillTps).toBe(120.5);
});

// ─── llama.cpp ────────────────────────────────────────────────────────────

it("detects llama.cpp from /slots and diffs slot counters", async () => {
  const clock = makeClock();
  const state = {
    slots: [{ id: 0, n_decoded: 10, n_prompt_tokens_processed: 5, is_processing: false }],
  };
  const srv = await startTracked({
    "/slots": () => ({ json: state.slots }),
    "/props": () => ({
      json: { model_alias: "Qwen2.5-7B", model_path: "/models/qwen.gguf", total_context_length: 32768 },
    }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("llama.cpp");
  expect(seed.model).toBe("Qwen2.5-7B");
  expect(seed.decodeTps).toBe(0);
  expect(seed.prefillTps).toBe(0);
  expect(seed.queueRunning).toBe(0);
  expect(seed.engineMeta).toEqual({ contextLength: 32768 });

  clock.advance(2000);
  state.slots = [{ id: 0, n_decoded: 50, n_prompt_tokens_processed: 25, is_processing: true }];
  const live = parseSnapshot(await probe.probe(false));
  expect(live.decodeTps).toBe(20);
  expect(live.prefillTps).toBe(10);
  expect(live.queueRunning).toBe(1);
});

// ─── SGLang ───────────────────────────────────────────────────────────────

it("detects SGLang; counter diffs win while advancing, sticky gauge fills idle", async () => {
  const clock = makeClock();
  const state = {
    loads: { loads: [{ num_running_reqs: 3, num_waiting_reqs: 1 }] },
    metrics: SGLANG_METRICS(2924, 500),
    lastGenThroughput: 0,
  };
  const srv = await startTracked({
    "/v1/loads": () => ({ json: state.loads }),
    "/metrics": () => ({ text: state.metrics }),
    "/server_info": () => ({
      json: {
        model_path:
          "/root/.cache/huggingface/hub/models--deepseek-ai--DeepSeek-V4-Flash-0731/snapshots/abc",
        context_length: 1048576,
        max_total_num_tokens: 2178048,
        max_running_requests: 16,
        internal_states: [{ last_gen_throughput: state.lastGenThroughput }],
      },
    }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("sglang");
  expect(seed.model).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
  expect(seed.decodeTps).toBe(0);
  expect(seed.prefillTps).toBe(0);
  expect(seed.queueRunning).toBe(3);
  expect(seed.queueWaiting).toBe(1);
  expect(seed.engineMeta).toEqual({
    contextLength: 1048576,
    kvPoolTokens: 2178048,
    maxRunningRequests: 16,
    lastGenThroughput: 0,
  });

  // Counters advance → live counter rates; the sticky gauge loses.
  clock.advance(2000);
  state.metrics = SGLANG_METRICS(3324, 600);
  state.lastGenThroughput = 41.2;
  const busy = parseSnapshot(await probe.probe(false));
  expect(busy.decodeTps).toBe(200); // Δgen 400 / 2 s
  expect(busy.prefillTps).toBe(50); // Δcompute 100 / 2 s (cache excluded)

  // Counters flat → gen_throughput gauge (changed at the previous poll) is live.
  clock.advance(2000);
  const gaugeLive = parseSnapshot(await probe.probe(false));
  expect(gaugeLive.decodeTps).toBe(41.2);
  expect(gaugeLive.prefillTps).toBe(0);

  // Sticky gauge expired and load drained → 0, never a stale leftover.
  clock.advance(7000);
  state.loads = { loads: [{ num_running_reqs: 0, num_waiting_reqs: 0 }] };
  const expired = parseSnapshot(await probe.probe(false));
  expect(expired.decodeTps).toBe(0);
  expect(expired.queueRunning).toBe(0);
});

it("SGLang reports the sticky last_gen_throughput when /metrics is off", async () => {
  const clock = makeClock();
  const state = { lastGenThroughput: 29.746 };
  const srv = await startTracked({
    "/v1/loads": () => ({ status: 404, json: {} }),
    "/metrics": () => ({ status: 404, text: "" }),
    "/server_info": () => ({
      json: {
        model_path: "org/model",
        context_length: 1048576,
        internal_states: [{ last_gen_throughput: state.lastGenThroughput }],
      },
    }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("sglang");
  expect(seed.decodeTps).toBe(0); // first sample only seeds the gauge

  clock.advance(2000);
  state.lastGenThroughput = 41.2;
  expect(parseSnapshot(await probe.probe(false)).decodeTps).toBe(41.2);

  // Unchanged within the live window → still reported.
  clock.advance(2000);
  expect(parseSnapshot(await probe.probe(false)).decodeTps).toBe(41.2);
});

// ─── q27 ──────────────────────────────────────────────────────────────────

it("detects q27 from owned_by; sums label sets; prefers live processed counters", async () => {
  const clock = makeClock();
  const state = { metrics: Q27_METRICS };
  const srv = await startTracked({
    "/v1/models": () => ({
      json: { data: [{ id: "qwen38-27b-mtp", owned_by: "q27", max_model_len: 262144 }] },
    }),
    "/metrics": () => ({ text: state.metrics }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("q27");
  expect(seed.model).toBe("qwen38-27b-mtp");
  expect(seed.decodeTps).toBe(0);
  expect(seed.prefillTps).toBe(0);
  expect(seed.queueRunning).toBe(2);
  expect(seed.kvCachePct).toBe(42);
  expect(seed.ttftP95Ms).toBeCloseTo(487.5, 1); // interpolated inside the le=0.5 bucket
  expect(seed.engineMeta).toEqual({ slotsTotal: 4, specAcceptRatio: 0.87 });

  clock.advance(2000);
  state.metrics = Q27_METRICS.replace(
    `q27_decode_tokens_total{api="chat"} 400`,
    `q27_decode_tokens_total{api="chat"} 550`,
  )
    .replace(`q27_prefill_computed_tokens_total{api="chat"} 150`, `q27_prefill_computed_tokens_total{api="chat"} 250`)
    .replace(`q27_prefill_cached_tokens_total{api="chat"} 50`, `q27_prefill_cached_tokens_total{api="chat"} 60`);
  const live = parseSnapshot(await probe.probe(false));
  expect(live.decodeTps).toBe(75); // Δ(chat 550+messages 100 − 500) / 2 s
  expect(live.prefillTps).toBe(50); // computed only; cached Δ10 excluded

  // A cached-token jump never inflates the computed prefill tile.
  clock.advance(2000);
  state.metrics = state.metrics.replace(
    `q27_prefill_cached_tokens_total{api="chat"} 60`,
    `q27_prefill_cached_tokens_total{api="chat"} 600`,
  );
  expect(parseSnapshot(await probe.probe(false)).prefillTps).toBe(0);
});

it("q27 live processed counters drive real-time rates", async () => {
  const clock = makeClock();
  const state = { metrics: Q27_LIVE_METRICS };
  const srv = await startTracked({
    "/v1/models": () => ({ json: { data: [{ id: "qwen38-27b-mtp", owned_by: "q27" }] } }),
    "/metrics": () => ({ text: state.metrics }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.decodeTps).toBe(0);
  expect(seed.queueRunning).toBe(1);

  clock.advance(2000);
  state.metrics = Q27_LIVE_METRICS.replace("q27_decode_tokens_processed_total 400", "q27_decode_tokens_processed_total 620")
    .replace("q27_prefill_computed_tokens_processed_total 150", "q27_prefill_computed_tokens_processed_total 190");
  const live = parseSnapshot(await probe.probe(false));
  expect(live.decodeTps).toBe(110); // (620−400)/2
  expect(live.prefillTps).toBe(20); // (190−150)/2
});

// ─── ds4 ──────────────────────────────────────────────────────────────────

it("detects ds4 from owned_by; counters are live, window gauges are fallback", async () => {
  const clock = makeClock();
  const state = { metrics: DS4_METRICS };
  const srv = await startTracked({
    "/v1/models": () => ({
      json: { data: [{ id: "deepseek-v4-flash", owned_by: "ds4.c", context_length: 1000000 }] },
    }),
    "/metrics": () => ({ text: state.metrics }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  const seed = parseSnapshot(await probe.probe(false));
  expect(seed.backend).toBe("ds4");
  expect(seed.model).toBe("deepseek-v4-flash");
  expect(seed.decodeTps).toBe(0);
  expect(seed.prefillTps).toBe(0);
  expect(seed.queueRunning).toBe(2);
  expect(seed.engineMeta).toEqual({
    contextLength: 1000000,
    banksTotal: 12,
    specAcceptRatio: 0.7736,
  });

  clock.advance(2000);
  state.metrics = DS4_METRICS.replace("ds4_tokens_decoded_total 50.0", "ds4_tokens_decoded_total 90.0").replace(
    `ds4_tokens_prefilled_total{kind="computed"} 100.0`,
    `ds4_tokens_prefilled_total{kind="computed"} 180.0`,
  );
  const live = parseSnapshot(await probe.probe(false));
  expect(live.decodeTps).toBe(20); // (90−50)/2
  expect(live.prefillTps).toBe(40); // computed (180−100)/2; cached Δ0 excluded

  // Without the counters, the ~60 s window gauges are the only source.
  const gaugeProbe = new LlmPortProbe({ port: srv.port, now: clock.now });
  state.metrics = "ds4_decode_tok_s 13.17\nds4_prefill_tok_s 197.78\n";
  const gauged = parseSnapshot(await gaugeProbe.probe(false));
  expect(gauged.decodeTps).toBe(13.17);
  expect(gauged.prefillTps).toBe(197.78);
});

// ─── LM Studio / Ollama ───────────────────────────────────────────────────

it("detects LM Studio before /v1/models and reports the model list only", async () => {
  const clock = makeClock();
  const srv = await startTracked({
    "/slots": () => ({ json: LMSTUDIO_MODELS }), // answers 200 on every path
    "/api/v0/models": () => ({ json: LMSTUDIO_MODELS }),
    "/v1/models": () => ({ json: { data: [{ id: "x" }] } }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });
  const snap = parseSnapshot(await probe.probe(false));
  expect(snap.backend).toBe("lmstudio");
  expect(snap.detected).toBe(true);
  expect(snap.model).toBe("qwen2.5-7b-instruct");
  expect(snap.decodeTps).toBeNull();
  expect(snap.prefillTps).toBeNull();
  expect(snap.engineMeta).toBeNull();
  expect(srv.hits.some((h) => h.path === "/v1/models")).toBe(false);
});

it("detects Ollama from /api/tags before the OpenAI probe", async () => {
  const clock = makeClock();
  const srv = await startTracked({
    "/api/tags": () => ({ json: { models: [{ name: "qwen3:8b", model: "qwen3:8b" }] } }),
    "/v1/models": () => ({ json: { data: [{ id: "x", owned_by: "library" }] } }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });
  const snap = parseSnapshot(await probe.probe(false));
  expect(snap.backend).toBe("ollama");
  expect(snap.model).toBe("qwen3:8b");
});

// ─── Detection-only mode, failures, multi-port, auth ──────────────────────

it("detection-only probes emit null metrics and leave counter windows untouched", async () => {
  const clock = makeClock();
  const state = {
    health: {
      ok: true,
      busy: true,
      backend: "exl3",
      prompt_tokens_total: 100,
      completion_tokens_total: 50,
      context_length: 65536,
    },
  };
  const srv = await startTracked({
    "/v1/models": () => ({ json: { data: [{ id: "qwen3.8-27b-exl3-3.5bpw-wm", owned_by: "exl3" }] } }),
    "/health": () => ({ json: state.health }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });

  clock.advance(2000);
  await probe.probe(false); // seed windows at t+2s

  clock.advance(2000);
  const det = parseSnapshot(await probe.probe(true)); // worker cadence at t+4s
  expect(det.backend).toBe("exl3");
  expect(det.detected).toBe(true);
  expect(det.model).toBe("qwen3.8-27b-exl3-3.5bpw-wm");
  expect(det.decodeTps).toBeNull();
  expect(det.prefillTps).toBeNull();
  expect(det.queueRunning).toBeNull();
  expect(det.kvCachePct).toBeNull();
  expect(det.ttftP95Ms).toBeNull();
  expect(det.engineMeta).toBeNull();

  clock.advance(2000);
  state.health = { ...state.health, completion_tokens_total: 90 };
  const live = parseSnapshot(await probe.probe(false)); // diff at t+6s
  // Δ40 over a 4 s window (t+2s → t+6s): a detectOnly window tick would have
  // split dt to 2 s and reported 20.
  expect(live.decodeTps).toBe(10);
});

it("keeps the cached backend while unreachable, then resets detection after 3 failures", async () => {
  const clock = makeClock();
  const srv = await startTracked({
    "/slots": () => ({ json: [{ id: 0, n_decoded: 1, is_processing: false }] }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });
  const first = parseSnapshot(await probe.probe(false));
  expect(first.backend).toBe("llama.cpp");
  await srv.close();

  clock.advance(2000);
  const down1 = parseSnapshot(await probe.probe(false));
  expect(down1.backend).toBe("llama.cpp"); // cached classification survives
  expect(down1.detected).toBe(true);
  expect(down1.decodeTps).toBeNull(); // nothing answered → metrics null

  clock.advance(2000);
  parseSnapshot(await probe.probe(false));
  clock.advance(2000);
  parseSnapshot(await probe.probe(false)); // 3rd consecutive failure

  clock.advance(2000);
  const reset = parseSnapshot(await probe.probe(false)); // re-detects from scratch
  expect(reset.backend).toBe("unknown");
  expect(reset.detected).toBe(false);
  expect(reset.model).toBeNull();
});

it("reports unknown/detected:false for a port that answers nothing recognizable", async () => {
  const clock = makeClock();
  const srv = await startTracked({
    "/": () => ({ json: { hello: "world" } }),
  });
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });
  const snap = parseSnapshot(await probe.probe(false));
  expect(snap.backend).toBe("unknown");
  expect(snap.detected).toBe(false);
  expect(snap.model).toBeNull();
  expect(snap.decodeTps).toBeNull();
});

it("probes ports independently: one probe instance per port", async () => {
  const clock = makeClock();
  const exl3State = {
    health: {
      ok: true,
      busy: true,
      backend: "exl3",
      prompt_tokens_total: 100,
      completion_tokens_total: 50,
      context_length: 65536,
    },
  };
  const exl3 = await startTracked({
    "/v1/models": () => ({ json: { data: [{ id: "m", owned_by: "exl3" }] } }),
    "/health": () => ({ json: exl3State.health }),
  });
  const vllmState = { metrics: VLLM_METRICS };
  const vllm = await startTracked({
    "/v1/models": () => ({ json: { data: [{ id: "meta-llama/Llama-3.1-8B" }] } }),
    "/metrics": () => ({ text: vllmState.metrics }),
  });

  const a = new LlmPortProbe({ port: exl3.port, now: clock.now });
  const b = new LlmPortProbe({ port: vllm.port, now: clock.now });
  expect(a.key).not.toBe(b.key);

  await a.probe(false);
  await b.probe(false);
  clock.advance(2000);
  exl3State.health = { ...exl3State.health, completion_tokens_total: 90 };
  vllmState.metrics = VLLM_METRICS.replace("500.0", "900.0");

  const snapA = parseSnapshot(await a.probe(false));
  const snapB = parseSnapshot(await b.probe(false));
  expect(snapA.backend).toBe("exl3");
  expect(snapA.decodeTps).toBe(20);
  expect(snapB.backend).toBe("vllm");
  expect(snapB.decodeTps).toBe(200);
});

it("sends Authorization: Bearer when an apiKey is configured", async () => {
  const clock = makeClock();
  const srv = await startTracked({
    "/v1/models": () => ({ json: { data: [{ id: "m", owned_by: "exl3" }] } }),
    "/health": () => ({ json: { ok: true, busy: false, backend: "exl3" } }),
  });
  const authed = new LlmPortProbe({ port: srv.port, now: clock.now, apiKey: "sk-test" });
  await authed.probe(false);
  const authedHits = srv.hits.filter((h) => h.path === "/v1/models");
  expect(authedHits.length).toBeGreaterThan(0);
  expect(authedHits.every((h) => h.authorization === "Bearer sk-test")).toBe(true);

  const anon = new LlmPortProbe({ port: srv.port, now: clock.now });
  await anon.probe(false);
  const anonHits = srv.hits.filter((h) => h.path === "/v1/models");
  expect(anonHits.at(-1)!.authorization).toBeNull();
});

it("re-detects when the detection TTL expires and the backend changed", async () => {
  const clock = makeClock();
  const routes: Routes = {
    "/v1/models": () => ({ json: { data: [{ id: "m", owned_by: "exl3" }] } }),
    "/health": () => ({ json: { ok: true, busy: false, backend: "exl3" } }),
  };
  const srv = await startTracked(routes);
  const probe = new LlmPortProbe({ port: srv.port, now: clock.now });
  expect((await probe.probe(false)).backend).toBe("exl3");

  // The engine was restarted as llama.cpp on the same port.
  routes["/v1/models"] = () => ({ status: 404, json: {} });
  routes["/slots"] = () => ({ json: [{ id: 0, n_decoded: 1, is_processing: false }] });

  clock.advance(2000);
  expect((await probe.probe(false)).backend).toBe("exl3"); // cached

  clock.advance(61_000);
  const redetected = parseSnapshot(await probe.probe(false));
  expect(redetected.backend).toBe("llama.cpp");
  expect(srv.hits.filter((h) => h.path === "/slots").length).toBeGreaterThan(0);
});

// ─── Parser helpers ───────────────────────────────────────────────────────

it("parses histograms across label sets and keeps the +Inf tail", () => {
  const body = `
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1",model_name="m"} 100.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="1.0",model_name="m"} 500.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="m"} 500.0
vllm:time_to_first_token_seconds_bucket{engine="1",le="0.1",model_name="m"} 50.0
vllm:time_to_first_token_seconds_bucket{engine="1",le="1.0",model_name="m"} 250.0
vllm:time_to_first_token_seconds_bucket{engine="1",le="+Inf",model_name="m"} 250.0
vllm:time_to_first_token_seconds_count{engine="0",model_name="m"} 500.0
vllm:time_to_first_token_seconds_count{engine="1",model_name="m"} 250.0
`;
  const h = parsePromHistogram(parsePromText(body), "vllm:time_to_first_token_seconds");
  expect(h.total).toBe(750);
  expect(h.buckets.find((b) => b.upper === 0.1)?.count).toBe(150);
  expect(h.buckets.find((b) => b.upper === 1.0)?.count).toBe(750);
  expect(h.buckets.find((b) => b.upper === Infinity)?.count).toBe(750);
  expect(promHistogramQuantile(h.buckets, h.total, 0.95)).toBeCloseTo(0.94375, 9); // inside le=1.0
});

it("refuses histograms where +Inf != _count and tails beyond the last finite bucket", () => {
  const inconsistent = parsePromHistogram(
    parsePromText(`
vllm:time_to_first_token_seconds_bucket{le="0.1"} 100.0
vllm:time_to_first_token_seconds_bucket{le="0.5"} 9000.0
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 9000.0
vllm:time_to_first_token_seconds_count 10000.0
`),
    "vllm:time_to_first_token_seconds",
  );
  expect(inconsistent.buckets).toEqual([]);
  expect(inconsistent.total).toBeNull();

  const tail = parsePromHistogram(
    parsePromText(`
vllm:time_to_first_token_seconds_bucket{le="1.0"} 50
vllm:time_to_first_token_seconds_bucket{le="10.0"} 95
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 100
vllm:time_to_first_token_seconds_count 100
`),
    "vllm:time_to_first_token_seconds",
  );
  expect(promHistogramQuantile(tail.buckets, tail.total, 0.97)).toBeNull(); // +Inf tail
});

it("matches the real le label even when a label value contains le=", () => {
  const body = `
vllm:time_to_first_token_seconds_bucket{engine="0",le="0.1",model_name="le=\\"0.5\\""} 100.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="1.0",model_name="le=\\"0.5\\""} 500.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="le=\\"0.5\\""} 500.0
vllm:time_to_first_token_seconds_count{engine="0",model_name="le=\\"0.5\\""} 500.0
`;
  const h = parsePromHistogram(parsePromText(body), "vllm:time_to_first_token_seconds");
  expect(h.total).toBe(500);
  expect(h.buckets[0]!.upper).toBe(0.1);
});

it("takes the max across TP-rank gauges and the sum across counters", () => {
  const series = parsePromText(`
sglang:gen_throughput{tp_rank="0"} 36.22
sglang:gen_throughput{tp_rank="1"} 36.22
sglang:generation_tokens_total{tp_rank="0"} 10
sglang:generation_tokens_total{tp_rank="1"} 20
`);
  expect(promMax(series, "sglang:gen_throughput")).toBe(36.22);
  expect(promSum(series, "sglang:generation_tokens_total")).toBe(30);
});

it("normalizes HF hub cache paths to org/name", () => {
  expect(normalizeModelId("/root/.cache/huggingface/models--thinkingmachines--Inkling-Small-NVFP4/snapshots/b6a99534467840620d411e4cd4ad5819b2610d9c")).toBe(
    "thinkingmachines/Inkling-Small-NVFP4",
  );
  expect(normalizeModelId("/data/hub/models--meta-llama--Llama-3.1-8B-Instruct")).toBe(
    "meta-llama/Llama-3.1-8B-Instruct",
  );
  expect(normalizeModelId("Qwen/Qwen2.5-7B-Instruct")).toBe("Qwen/Qwen2.5-7B-Instruct");
  expect(normalizeModelId(null)).toBeNull();
  expect(normalizeModelId("   ")).toBeNull();
});
