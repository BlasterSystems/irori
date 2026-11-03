import { z } from "zod";
import { usagePartMetaSchema, usageRequestSchema } from "./usage.js";
import { currencySchema } from "./currency.js";

/**
 * Usage API contracts (M8): server → browser response shapes for the four
 * Usage pages, parsed by shared zod schemas on both sides.
 */

export const USAGE_RANGES = ["1h", "24h", "7d", "30d", "90d"] as const;
export const usageRangeSchema = z.enum(USAGE_RANGES);
export type UsageRange = (typeof USAGE_RANGES)[number];

/** Buckets read per range (no minute usage buckets — hour floor is 1h). */
export function usageGranularity(range: UsageRange): "hour" | "day" {
  return range === "30d" || range === "90d" ? "day" : "hour";
}

export function usageRangeMs(range: UsageRange): number {
  switch (range) {
    case "1h":
      return 3_600_000;
    case "24h":
      return 24 * 3_600_000;
    case "7d":
      return 7 * 86_400_000;
    case "30d":
      return 30 * 86_400_000;
    case "90d":
      return 90 * 86_400_000;
  }
}

const nullableNumber = z.number().nullable();
const nullableInt = z.number().int().nullable();

/** One raw stored request as served to the UI (nodeId + receive time added). */
export const usageRequestRowSchema = usageRequestSchema.extend({
  nodeId: z.string().uuid(),
  /** Server receive time (bucketing key). */
  receivedAtMs: z.number(),
  /** Stored part metadata (no gz); empty until retention stores bodies. */
  parts: z.array(usagePartMetaSchema).default([]),
});

export type UsageRequestRow = z.infer<typeof usageRequestRowSchema>;

/** One bucket point of the activity/token series (model folded). */
export const usageSeriesPointSchema = z.object({
  t: z.string(),
  requests: z.number().int(),
  errors: z.number().int(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  cachedTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  ttftP50Ms: nullableNumber,
  ttftP95Ms: nullableNumber,
  decodeTps: nullableNumber,
  /** IRI-072: bucket cost in minor units; 0 when unpriced (kpis.costCurrency
   *  null tells the two apart). Absent on pre-IRI-072 hubs. */
  costMinor: z.number().int().nonnegative().default(0),
});

export const usageTokenMixRowSchema = z.object({
  model: z.string(),
  requests: z.number().int(),
  errors: z.number().int(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  cachedTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  costMinor: z.number().int().nonnegative().default(0),
});

export const usageOverviewResponseSchema = z.object({
  range: usageRangeSchema,
  granularity: z.enum(["hour", "day"]),
  kpis: z.object({
    requests: z.number().int(),
    errors: z.number().int(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    cachedTokens: z.number(),
    reasoningTokens: z.number(),
    totalTokens: z.number(),
    ttftP50Ms: nullableNumber,
    ttftP95Ms: nullableNumber,
    decodeTps: nullableNumber,
  }),
  series: z.array(usageSeriesPointSchema),
  tokenMix: z.array(usageTokenMixRowSchema),
  /** IRI-070: quarantined (schema-rejected) captures in range — a warn chip,
   *  never silent loss. Absent on pre-IRI-070 hubs (old web defaults 0). */
  rejected: z.number().int().nonnegative().default(0),
  /** IRI-072: fleet cost over the window (minor units of `costCurrency`);
   *  `costCurrency` null = no pricing configured (cost 0 means unpriced). */
  costMinor: z.number().int().nonnegative().default(0),
  costCurrency: currencySchema.nullable().default(null),
});

export type UsageOverviewResponse = z.infer<typeof usageOverviewResponseSchema>;

export const usageRequestsResponseSchema = z.object({
  total: z.number().int(),
  rows: z.array(usageRequestRowSchema),
});

export type UsageRequestsResponse = z.infer<typeof usageRequestsResponseSchema>;

export const usageErrorGroupSchema = z.object({
  sig: z.string(),
  count: z.number().int(),
  firstSeenMs: z.number(),
  lastSeenMs: z.number(),
  sample: z.string(),
  models: z.array(z.string()),
  status: nullableInt,
});

export const usageErrorsResponseSchema = z.object({
  range: usageRangeSchema,
  groups: z.array(usageErrorGroupSchema),
});

export type UsageErrorsResponse = z.infer<typeof usageErrorsResponseSchema>;

export const usageModelRowSchema = z.object({
  model: z.string(),
  requests: z.number().int(),
  errors: z.number().int(),
  totalTokens: z.number(),
  ttftP50Ms: nullableNumber,
  ttftP95Ms: nullableNumber,
  decodeTps: nullableNumber,
  /** IRI-072: bucket-cost sum (minor units of `costCurrency` on the response). */
  costMinor: z.number().int().nonnegative().default(0),
});

export const usageModelSeriesPointSchema = z.object({
  t: z.string(),
  ttftP50Ms: nullableNumber,
  decodeTps: nullableNumber,
  completionTokens: z.number(),
});

export const usageModelsResponseSchema = z.object({
  range: usageRangeSchema,
  models: z.array(usageModelRowSchema),
  series: z.array(z.object({ model: z.string(), points: z.array(usageModelSeriesPointSchema) })),
  /** IRI-074: pricing currency; null = unset (UI shows a Configure pricing CTA). */
  costCurrency: currencySchema.nullable().default(null),
});

export type UsageModelsResponse = z.infer<typeof usageModelsResponseSchema>;

/** One client-identity group of the Agents view (raw-row aggregation, IR-55). */
export const usageAgentGroupSchema = z.object({
  project: z.string().nullable(),
  agentType: z.enum(["main", "subagent"]).nullable(),
  name: z.string().nullable(),
  /** sha256 fingerprint when an issued key matched; null otherwise. */
  keyHash: z.string().nullable(),
  /** Source addresses seen for this identity (fallback label when unnamed). */
  sourceAddrs: z.array(z.string()),
  requests: z.number().int(),
  errors: z.number().int(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  /** IRI-072: priced via the per-group (group × model) token sums. */
  costMinor: z.number().int().nonnegative().default(0),
  lastSeenMs: z.number(),
});

export type UsageAgentGroup = z.infer<typeof usageAgentGroupSchema>;

export const usageAgentsResponseSchema = z.object({
  range: usageRangeSchema,
  groups: z.array(usageAgentGroupSchema),
  /** True when high cardinality exceeded the 200-group cap. */
  truncated: z.boolean().default(false),
});

export type UsageAgentsResponse = z.infer<typeof usageAgentsResponseSchema>;

/** One (tool × model) attribution row of the Tools view (IR-54). */
export const usageToolRowSchema = z.object({
  tool: z.string(),
  model: z.string().nullable(),
  calls: z.number().int(),
  errors: z.number().int(),
  argsChars: z.number().int(),
  resultChars: z.number().int(),
  /** Attributed shares (largest-remainder of the owning requests' totals). */
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  /** IRI-072: priced from the row's own model at read time. */
  costMinor: z.number().int().nonnegative().default(0),
  lastSeenMs: z.number(),
});
export type UsageToolRow = z.infer<typeof usageToolRowSchema>;

export const usageToolSeriesPointSchema = z.object({ t: z.string(), tokens: z.number().int() });
export const usageToolsResponseSchema = z.object({
  range: usageRangeSchema,
  tools: z.array(usageToolRowSchema),
  /** Token series for the top tools (tokens = prompt + completion shares). */
  series: z.array(z.object({ tool: z.string(), points: z.array(usageToolSeriesPointSchema) })),
});
export type UsageToolsResponse = z.infer<typeof usageToolsResponseSchema>;

/* ── Chats: session reconstruction (IR-53, reads IR-52 bodies) ───────────── */

/** One reconstructed conversation turn (from stored body parts). */
export const chatTurnSchema = z.object({
  requestId: z.string().uuid(),
  kind: z.enum(["message", "response", "error", "marker"]),
  role: z.string().nullable(),
  /** Text content (or the stored truncation prefix). */
  text: z.string().nullable(),
  /** base64 data URLs (byte-exact as sent). */
  imageUrls: z.array(z.string()),
  toolCalls: z.array(z.object({ id: z.string().nullable(), name: z.string(), arguments: z.string() })),
  toolResult: z.object({ callId: z.string(), error: z.boolean() }).nullable(),
  truncated: z.boolean().default(false),
  ts: z.number().int(),
  model: z.string().nullable(),
});
export type ChatTurn = z.infer<typeof chatTurnSchema>;

/** One chained session summary (list view). */
export const chatSessionSchema = z.object({
  /** First request of the session — the detail handle. */
  id: z.string().uuid(),
  startMs: z.number().int(),
  lastMs: z.number().int(),
  requests: z.number().int(),
  /** Message turns in the final request snapshot. */
  messages: z.number().int(),
  promptTokens: z.number().int().nullable(),
  totalTokens: z.number(),
  models: z.array(z.string()),
  clientName: z.string().nullable(),
  clientProject: z.string().nullable(),
  clientAgentType: z.enum(["main", "subagent"]).nullable(),
  sourceAddrs: z.array(z.string()),
  compacted: z.boolean(),
  truncated: z.boolean(),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatsResponseSchema = z.object({
  range: usageRangeSchema,
  sessions: z.array(chatSessionSchema),
  /** Requests captured WITHOUT stored bodies in range — hints retention off. */
  capturedWithoutBodies: z.number().int(),
});
export type ChatsResponse = z.infer<typeof chatsResponseSchema>;

export const chatDetailSchema = z.object({
  id: z.string().uuid(),
  startMs: z.number().int(),
  lastMs: z.number().int(),
  requests: z.number().int(),
  compacted: z.boolean(),
  truncated: z.boolean(),
  clientName: z.string().nullable(),
  clientProject: z.string().nullable(),
  clientAgentType: z.enum(["main", "subagent"]).nullable(),
  sourceAddrs: z.array(z.string()),
  models: z.array(z.string()),
  turns: z.array(chatTurnSchema),
});
export type ChatDetail = z.infer<typeof chatDetailSchema>;

/** One issued client identity (IR-55) — the key itself is never listed. */
export const clientIdentityInfoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  project: z.string().nullable(),
  agentType: z.enum(["main", "subagent"]).nullable(),
  /** sha256 fingerprint of the issued key; null for header-only identities. */
  keyHash: z.string().nullable(),
  createdAtMs: z.number().int(),
});
export type ClientIdentityInfo = z.infer<typeof clientIdentityInfoSchema>;

export const usageClientsResponseSchema = z.object({ clients: z.array(clientIdentityInfoSchema) });
export type UsageClientsResponse = z.infer<typeof usageClientsResponseSchema>;

/** Creation response — carries the plaintext key exactly once. */
export const clientIdentityCreatedSchema = clientIdentityInfoSchema.extend({ key: z.string().min(1) });
export type ClientIdentityCreated = z.infer<typeof clientIdentityCreatedSchema>;

/** Common filters across the usage endpoints. */
export interface UsageFilters {
  range: UsageRange;
  nodeId?: string;
  model?: string;
  /** IR-55 client dimensions (raw-row filters; bucket models ignore them). */
  project?: string;
  agentType?: "main" | "subagent";
}
