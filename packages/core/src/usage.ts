import { z } from "zod";

/** Body-retention caps (IR-52): the agent truncates stored bodies at these. */
export const bodyRetentionSchema = z.object({
  /** Original (uncompressed) request+response bytes stored per request. */
  bodyCapBytes: z.number().int().positive(),
  /** Original bytes stored per single part; oversize parts are cut (truncated). */
  partCapBytes: z.number().int().positive(),
});
export type BodyRetention = z.infer<typeof bodyRetentionSchema>;

/**
 * One content-addressed body part (IR-52): canonical UTF-8 JSON bytes,
 * gzip-compressed for transport/storage, addressed by the sha256 of the
 * UNcompressed bytes. `index` is the part's ordinal position within the
 * request's stored sequence (request parts first, then response/error/marker).
 */
export const usagePartWireSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(["message", "prompt", "input", "response", "error", "marker"]),
  /** OpenAI message role for `message` parts; null otherwise. */
  role: z.string().min(1).max(40).nullable().default(null),
  index: z.number().int().nonnegative(),
  /** Original (uncompressed) byte length of the canonical part content. */
  bytes: z.number().int().nonnegative(),
  /** base64 of gzip(canonical bytes). */
  gz: z.string().min(1),
  /** True when partCapBytes cut the canonical content. */
  truncated: z.boolean().default(false),
});
export type UsagePartWire = z.infer<typeof usagePartWireSchema>;

/** Part metadata without the gz blob — the shape browsers receive (SSE/API). */
export const usagePartMetaSchema = usagePartWireSchema.omit({ gz: true });
export type UsagePartMeta = z.infer<typeof usagePartMetaSchema>;

/**
 * LLM usage capture (M8, ADR-0008): one per-request record from the agent's
 * capture proxy. Native wire fields always; optional body parts when the
 * setup opts into retention (IR-52, default off).
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
  /** IR-52: stored body parts; empty when retention is off or nothing parsed. */
  parts: z.array(usagePartWireSchema).max(8192).default([]),
});

export type UsageRequest = z.infer<typeof usageRequestSchema>;

/** Hard cap per upload frame — matches the owner decision (30–60 s / 500). */
export const MAX_USAGE_BATCH = 500;

/**
 * WS receive limit on the hub for agent frames (IR-52: retained bodies make
 * batches large; the agent's part budget stays under this with margin).
 */
export const MAX_USAGE_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Per-frame budget on the SUM of attached part bytes (base64 gz, IR-52).
 * Worst single event (16 MiB body cap + 2×4 MiB response/error parts,
 * incompressible) ≈ 32 MiB base64 — fits under both the budget and the hub
 * frame limit, so a singleton always travels and no batch can poison the
 * connection with an oversized frame.
 */
export const USAGE_BATCH_PART_BUDGET_BYTES = 48 * 1024 * 1024;

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
