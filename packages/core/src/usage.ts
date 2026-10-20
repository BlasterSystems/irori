import { z } from "zod";

/**
 * LLM usage capture (M8, ADR-0008): one per-request record from the agent's
 * capture proxy. Wire fields only — no request/response bodies (IR-51).
 * Nullable numbers mean "not detected" (never zero-guessed), mirroring the
 * LLM probe contract.
 */
export const usageRequestSchema = z.object({
  /** Client-generated UUID v4 — the exactly-once key end to end. */
  id: z.string().uuid(),
  /** Agent wall-clock request start (advisory; server receive time buckets). */
  ts: z.number().int().nonnegative(),
  setupId: z.string().uuid().nullable().default(null),
  /** Client-facing port (the proxy listener), not the loopback engine port. */
  port: z.number().int().positive(),
  model: z.string().min(1).nullable().default(null),
  /** Request target path, e.g. "/v1/chat/completions". */
  endpoint: z.string().min(1),
  stream: z.boolean().default(false),
  /** Upstream HTTP status; null when no response arrived (refused/aborted). */
  status: z.number().int().nullable().default(null),
  finishReason: z.string().min(1).nullable().default(null),
  /** Terminal error message; null when the request completed normally. */
  error: z.string().min(1).nullable().default(null),
  /** Normalized signature of `error` (normalizeErrorSignature) for grouping. */
  errorSig: z.string().min(1).nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  /** Time to first streamed content delta; null for non-streaming/failed. */
  ttftMs: z.number().int().nonnegative().nullable().default(null),
  /** completionTokens per decode second (first→last delta window). */
  decodeTps: z.number().nonnegative().nullable().default(null),
  promptTokens: z.number().int().nonnegative().nullable().default(null),
  completionTokens: z.number().int().nonnegative().nullable().default(null),
  cachedTokens: z.number().int().nonnegative().nullable().default(null),
  reasoningTokens: z.number().int().nonnegative().nullable().default(null),
  totalTokens: z.number().int().nonnegative().nullable().default(null),
  /** Engine-internal metrics block (e.g. TensorFold), verbatim. */
  engineMeta: z.record(z.string(), z.unknown()).nullable().default(null),
  reqBytes: z.number().int().nonnegative(),
  resBytes: z.number().int().nonnegative(),
  /** Client socket address as seen by the proxy. */
  sourceAddr: z.string().min(1).nullable().default(null),
});

export type UsageRequest = z.infer<typeof usageRequestSchema>;

/** Hard cap per upload frame — matches the owner decision (30–60 s / 500). */
export const MAX_USAGE_BATCH = 500;

/** Agent → server: one batch of captured requests (≤ MAX_USAGE_BATCH). */
export const usageBatchMsgSchema = z.object({
  type: z.literal("usage-batch"),
  schemaVersion: z.number().int().nonnegative(),
  agentVersion: z.string().min(1),
  events: z.array(usageRequestSchema).min(1).max(MAX_USAGE_BATCH),
});

export type UsageBatchMsg = z.infer<typeof usageBatchMsgSchema>;

/** Server → agent: durable insert succeeded for these ids (delete from buffer). */
export const usageBatchAckMsgSchema = z.object({
  type: z.literal("usage-batch-ack"),
  ids: z.array(z.string().uuid()).min(1),
});

export type UsageBatchAckMsg = z.infer<typeof usageBatchAckMsgSchema>;

/**
 * Normalizes an error message into a stable group signature: UUIDs, long hex
 * ids and numbers collapse to placeholders, whitespace collapses. OMP-stats
 * style groups without storing bodies.
 */
export function normalizeErrorSignature(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "U")
    .replace(/\b(?:0x)?[0-9a-f]{16,}\b/gi, "H")
    .replace(/\d+(?:\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** OpenAI-compat inference endpoints the proxy captures (ADR-0008 §2). */
export const CAPTURED_ENDPOINT_RE = /^\/v1\/(chat\/completions|completions|embeddings|responses)$/;
