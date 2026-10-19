import { z } from "zod";

export const LLM_BACKENDS = [
  "vllm",
  "llama.cpp",
  "sglang",
  "exl3",
  "tensorfold",
  "q27",
  "lmstudio",
  "ollama",
  "ds4",
  "unknown",
] as const;

export const llmBackendSchema = z.enum(LLM_BACKENDS);
export type LlmBackend = z.infer<typeof llmBackendSchema>;

/**
 * One LLM port on a node. Rates/queue/KV/latency come from engine counters
 * or /metrics where published; anything the engine does not publish is null
 * ("not detected"), never zero. Workers send detection-only probes.
 */
export const llmPortSnapshotSchema = z.object({
  port: z.number().int().positive(),
  /** Probe target host — usually 127.0.0.1 (the agent's own node). */
  host: z.string().min(1).default("127.0.0.1"),
  backend: llmBackendSchema,
  /** false = nothing answered on this port (still reported, so panels show idle). */
  detected: z.boolean(),
  model: z.string().nullable().default(null),
  decodeTps: z.number().nonnegative().nullable().default(null),
  prefillTps: z.number().nonnegative().nullable().default(null),
  queueRunning: z.number().int().nonnegative().nullable().default(null),
  queueWaiting: z.number().int().nonnegative().nullable().default(null),
  kvCachePct: z.number().min(0).max(100).nullable().default(null),
  ttftP95Ms: z.number().nonnegative().nullable().default(null),
  e2eP95Ms: z.number().nonnegative().nullable().default(null),
  itlP95Ms: z.number().nonnegative().nullable().default(null),
  /** Engine-specific extras (e.g. TensorFold prefill/decode split), verbatim. */
  engineMeta: z.record(z.string(), z.unknown()).nullable().default(null),
  /** Cumulative token counters where the engine publishes them (M7 ledger).
   *  Null counters mean "this backend does not expose it" — the ledger
   *  records coverage and never guesses a zero. */
  tokens: z
    .object({
      generated: z.number().nonnegative().nullable().default(null),
      prompt: z.number().nonnegative().nullable().default(null),
      cached: z.number().nonnegative().nullable().default(null),
    })
    .nullable()
    .default(null),
  probedAtMs: z.number().nonnegative(),
});

export type LlmPortSnapshot = z.infer<typeof llmPortSnapshotSchema>;

/** Agent → server LLM probe message (separate cadence from hardware snapshots). */
export const llmMsgSchema = z.object({
  type: z.literal("llm"),
  schemaVersion: z.number().int().nonnegative(),
  agentVersion: z.string().min(1),
  ports: z.array(llmPortSnapshotSchema),
});

export type LlmMsg = z.infer<typeof llmMsgSchema>;

/** Server → browser event. */
export const llmEventSchema = z.object({
  type: z.literal("llm"),
  serverTimeMs: z.number(),
  nodeId: z.string().uuid(),
  ports: z.array(llmPortSnapshotSchema),
});

export type LlmEvent = z.infer<typeof llmEventSchema>;

/** Per-port probe assignment delivered via config-update. */
export const llmPortAssignmentSchema = z.object({
  port: z.number().int().positive(),
  host: z.string().min(1).default("127.0.0.1"),
});

export type LlmPortAssignment = z.infer<typeof llmPortAssignmentSchema>;
