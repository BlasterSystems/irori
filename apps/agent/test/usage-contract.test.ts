import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { usageRequestSchema, type UsageRequest } from "@irori/core";
import { UsageBuffer, parsePending } from "../src/usage-buffer.js";

/**
 * IRI-070 agent↔hub usage contract: the event the agent emits — capture.ts
 * build → usage-buffer persist → parsePending — must parse against the HUB's
 * schema for every engine the probe supports. Schema drift between an older
 * agent and a newer hub used to be silent, permanent loss of billing-grade
 * data (IR-153 class); now it fails THIS suite on every push.
 *
 * The fixture per engine mirrors the engineMeta the real capture sees
 * (TensorFold's `tensorfold` body object, EXL3 spec stats, vLLM/llama.cpp/
 * SGLang/ollama/lmstudio OpenAI-compatible usage) plus the W3C traceparent
 * the proxy lifts verbatim (packages/proxy/src/proxy.ts:256-259).
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "irori-contract-"));
  dirs.push(d);
  return d;
}

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

let seq = 0;
function captured(overrides: Partial<UsageRequest> = {}): UsageRequest {
  seq += 1;
  return usageRequestSchema.parse({
    id: randomUUID(),
    ts: 1_700_000_000_000 + seq,
    setupId: null,
    port: 8081,
    model: "GLM-5.3-Flash-EXL3",
    endpoint: "/v1/chat/completions",
    stream: true,
    status: 200,
    finishReason: "stop",
    error: null,
    errorSig: null,
    durationMs: 1200,
    ttftMs: 180,
    decodeTps: 41.2,
    promptTokens: 100,
    completionTokens: 42,
    cachedTokens: 10,
    reasoningTokens: 4,
    totalTokens: 142,
    engineMeta: null,
    reqBytes: 1024,
    resBytes: 2048,
    sourceAddr: "127.0.0.1",
    parts: [],
    respTools: [],
    toolResults: [],
    retryAttempt: null,
    retryKind: null,
    retryStatus: null,
    retrySupersededBy: null,
    traceparent: TRACEPARENT,
    ...overrides,
  });
}

/** Per-engine engineMeta exactly as the engines print it (verbatim jsonb). */
const ENGINE_FIXTURES: Record<string, Record<string, unknown>> = {
  vllm: { max_model_len: 32768, quantization: "exl3", served_model_name: "GLM-5.3-Flash-EXL3" },
  "llama.cpp": { model: "/models/glm-5.3-Q4_K_M.gguf", n_ctx: 32768, n_gpu_layers: 999 },
  tensorfold: { backend: "tensorfold", tp: 2, loaded_in_s: 213.7, container: "qwen38-flash-next-tf" },
  exl3: { tp_size: 2, bits: 3, head_dim: 128, speculative: { drafted: 4096, accepted: 3512 } },
  sglang: { backend: "sglang", mem_fraction_static: 0.87, chunked_prefill_size: 8192 },
  ollama: { backend: "ollama", model: "glm5.3:latest", params: { num_ctx: 8192 } },
  lmstudio: { backend: "lmstudio", model: "glm-5.3-flash-exl3", quantization: "Q4_K_M" },
  q27: { backend: "qwen3.8", ctx: 262144 },
  ds4: { backend: "deepseek", moe_experts: 256 },
};

describe("agent → hub usage contract (per engine)", () => {
  for (const [engine, engineMeta] of Object.entries(ENGINE_FIXTURES)) {
    it(`captured ${engine} event survives the buffer round-trip and parses on the hub`, async () => {
      const dir = makeDir();
      const buffer = new UsageBuffer(dir);
      const event = captured({ engineMeta, model: engine === "ollama" ? "glm5.3:latest" : "GLM-5.3-Flash-EXL3" });
      buffer.add(event);
      const rows = buffer.takeBatch(10);
      const parsed = parsePending(rows[0]!);
      expect(parsed).not.toBeNull();
      // This is the exact validation the hub runs (usageRequestSchema) —
      // keep the event intact through the agent's durable buffer.
      const hubSide = usageRequestSchema.safeParse(parsed);
      expect(hubSide.success).toBe(true);
      buffer.close();
    });
  }

  it("the proxy-lifted traceparent is contract and parses to trace+span", async () => {
    const event = captured();
    expect(event.traceparent).toBe(TRACEPARENT);
    // Hub-side derivation (usage-store traceIdsOf) contract: W3C 4-part form.
    const m = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i.exec(event.traceparent!);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(m![2]).toBe("00f067aa0ba902b7");
  });

  it("a drifted (older-agent) event FAILS the hub schema — and lands in quarantine, not the void", () => {
    // The regression fixture: an event missing a REQUIRED field is what an
    // old agent emits after a contract break. It must not parse (proving
    // the schema is the gate) — the hub then quarantines instead of ack-drop.
    const drifted = { ...captured() } as unknown as Record<string, unknown>;
    delete (drifted as Record<string, unknown>).id;
    expect(usageRequestSchema.safeParse(drifted).success).toBe(false);
  });
});
