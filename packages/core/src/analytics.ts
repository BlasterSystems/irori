import { z } from "zod";

/**
 * Analytics (M7, SPEC §9): five lenses over the rollup buckets — never raw
 * scans. Aggregation semantics are per lens and documented here because
 * they are physical, not cosmetic:
 *  - decode/tokens/power: additive (tok/s, tokens, watts sum across ports,
 *    nodes and cluster members).
 *  - memory: sums (used/total pool sizes).
 *  - temps: fleet-max semantics — cluster aggregates are max-of-maxes for
 *    highs, min-of-mins for lows, mean-of-means for averages, any for
 *    throttle flags. Thermals never add.
 */

export const ANALYTICS_LENSES = ["memory", "decode", "power", "temps", "tokens"] as const;
export const analyticsLensSchema = z.enum(ANALYTICS_LENSES);
export type AnalyticsLens = (typeof ANALYTICS_LENSES)[number];

export const ANALYTICS_RANGES = ["30m", "1h", "4h", "24h", "7d", "30d", "90d"] as const;
export const analyticsRangeSchema = z.enum(ANALYTICS_RANGES);
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export type AnalyticsRangeValue = AnalyticsRange;

export const ANALYTICS_GROUP_BY = ["cluster", "node"] as const;
export const analyticsGroupBySchema = z.enum(ANALYTICS_GROUP_BY);
export type AnalyticsGroupBy = (typeof ANALYTICS_GROUP_BY)[number];

/* ── Token macro totals (IRI-040 / IR-118) ────────────────────────────────── */

/**
 * The owner-specified macro metrics over a range, aggregated from the M7
 * token ledger (never the capture proxy): `total = generated + prompt` and
 * `cacheHitPct = cached / prompt × 100` (0 when prompt is 0). Used for the
 * tokens lens' `fleet` row and derivable per model / group.
 */
export const tokenTotalsSchema = z.object({
  total: z.number().int().nonnegative(),
  generated: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  cacheHitPct: z.number().nonnegative(),
});
export type TokenTotals = z.infer<typeof tokenTotalsSchema>;

/** Ranges → bucket granularity. Temps reads minute buckets for 7d (min/max
 *  pairs preserve spikes); 30m/1h/4h read minute buckets (tokens needs them
 *  below the hour); 24h/7d use hour, 30d/90d day. */
export function analyticsGranularity(lens: AnalyticsLens, range: AnalyticsRangeValue): "minute" | "hour" | "day" {
  if (lens === "temps" && range === "7d") return "minute";
  switch (range) {
    case "30m":
    case "1h":
    case "4h":
      return "minute";
    case "24h":
    case "7d":
      return "hour";
    case "30d":
    case "90d":
      return "day";
  }
}

export function analyticsRangeMs(range: AnalyticsRangeValue): number {
  switch (range) {
    case "30m":
      return 30 * 60_000;
    case "1h":
      return 3_600_000;
    case "4h":
      return 4 * 3_600_000;
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

/** One group's series. `key` is the setup id (cluster) or node id (node);
 *  `label` is display-ready. The "standalone" pseudo-group aggregates nodes
 *  that belong to no serving setup. */
export const analyticsSeriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  points: z.array(
    z.object({
      /** Bucket start, epoch ms UTC. */
      t: z.number(),
      /** 0..1 fraction of bucket samples that carried this metric. */
      coverage: z.number().min(0).max(1).nullable().default(null),
      // Memory lens (bytes).
      usedBytes: z.number().nullable().default(null),
      totalBytes: z.number().nullable().default(null),
      gpuUsedBytes: z.number().nullable().default(null),
      // Decode lens (tok/s).
      decodeTps: z.number().nullable().default(null),
      prefillTps: z.number().nullable().default(null),
      // Power lens (watts, estimated).
      watts: z.number().nullable().default(null),
      gpuW: z.number().nullable().default(null),
      cpuW: z.number().nullable().default(null),
      baseW: z.number().nullable().default(null),
      // Temps lens (°C).
      gpuMin: z.number().nullable().default(null),
      gpuMax: z.number().nullable().default(null),
      gpuAvg: z.number().nullable().default(null),
      cpuMin: z.number().nullable().default(null),
      cpuMax: z.number().nullable().default(null),
      cpuAvg: z.number().nullable().default(null),
      /** Any member GPU reported a throttle reason in this bucket (temps lens). */
      throttled: z.boolean().nullable().default(null),
      // Tokens lens (count deltas).
      generated: z.number().nullable().default(null),
      prompt: z.number().nullable().default(null),
      cached: z.number().nullable().default(null),
    }),
  ),
});

export type AnalyticsSeries = z.infer<typeof analyticsSeriesSchema>;
export type AnalyticsSeriesInput = z.input<typeof analyticsSeriesSchema>;
export type AnalyticsPoint = z.infer<typeof analyticsSeriesSchema>["points"][number];
/** Builders may set only the lens-relevant keys; parsing fills the defaults. */
export type AnalyticsPointInput = z.input<typeof analyticsSeriesSchema>["points"][number];

export const analyticsResponseSchema = z.object({
  lens: analyticsLensSchema,
  range: analyticsRangeSchema,
  groupBy: analyticsGroupBySchema,
  granularity: z.enum(["minute", "hour", "day"]),
  series: z.array(analyticsSeriesSchema),
  /** Tokens lens only: per-model totals over the selected range — whole-ledger
   *  sums (never a top-N subset; capped at 100 rows), with the macro columns
   *  (IRI-040). */
  models: z
    .array(
      z.object({
        model: z.string(),
        generated: z.number().int().nonnegative(),
        prompt: z.number().int().nonnegative(),
        cached: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        cacheHitPct: z.number().nonnegative(),
      }),
    )
    .default([]),
  /** Tokens lens only (IRI-040): fleet-wide macro totals for the range —
   *  the same scope as `series` (respects setupId/nodeId filters). Null for
   *  every other lens. */
  fleet: tokenTotalsSchema.nullable().default(null),
});

export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;

/** Energy estimation constants (SPEC §9, NVIDIA DGX Spark documentation):
 *  GB10 SOC TDP 140 W (GPU+CPU); 100 W budget for other components; 240 W
 *  peak system power. Estimated watts = gpu board + cpu package + base
 *  overhead, clamped to the system envelope. Labeled estimated, never
 *  wall-metered. */
export const GB10_SOC_TDP_W = 140;
export const GB10_SYSTEM_ENVELOPE_W = 240;
export const DEFAULT_BASE_OVERHEAD_W = 40;

/** Monthly archive row (Wh). Tokens for Wh/token come from the ledger. */
export const energyMonthlySchema = z.object({
  nodeId: z.string().uuid(),
  /** ISO month start (YYYY-MM-01T00:00:00Z). */
  monthStart: z.string(),
  samples: z.number().int().nonnegative(),
  gpuWh: z.number().nonnegative().nullable(),
  cpuWh: z.number().nonnegative().nullable(),
  baseWh: z.number().nonnegative().nullable(),
  totalWh: z.number().nonnegative().nullable(),
  /** Fraction of hour-buckets in the month that carried gpu/cpu readings. */
  gpuCoverage: z.number().min(0).max(1).nullable(),
  cpuCoverage: z.number().min(0).max(1).nullable(),
});

export type EnergyMonthly = z.infer<typeof energyMonthlySchema>;
