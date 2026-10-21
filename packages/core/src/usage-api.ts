import { z } from "zod";
import { usagePartMetaSchema, usageRequestSchema } from "./usage.js";

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
  /** ISO bucket start. */
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
});

export type UsageModelsResponse = z.infer<typeof usageModelsResponseSchema>;

/** Common filters across the usage endpoints. */
export interface UsageFilters {
  range: UsageRange;
  nodeId?: string;
  model?: string;
}
