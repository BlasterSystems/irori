import { z } from "zod";

/**
 * IRI-069: health rules engine. Server-side thresholds over the ingest path —
 * the single source of truth (the web reads `/api/v1/health/thresholds`).
 */

export const healthMetricSchema = z.enum([
  "gpu_temp_c",
  "disk_pct",
  "kernel_xid",
  "throttle_active",
  "power_w",
  "node_offline",
  "telemetry_gap_s",
  /** IR-179: node-online journal events per 5 min window (reconnect storm). */
  "reconnect_storm",
]);
export type HealthMetric = z.infer<typeof healthMetricSchema>;

export const healthSeveritySchema = z.enum(["info", "warn", "critical"]);
export type HealthSeverity = z.infer<typeof healthSeveritySchema>;

export const healthOpSchema = z.enum(["gte", "lte", "gt", "lt", "eq"]);

/** One rule row (wire form). `hasWebhook` never exposes the encrypted URL. */
export const healthRuleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  metric: healthMetricSchema,
  op: healthOpSchema,
  threshold: z.number(),
  severity: healthSeveritySchema,
  scope: z.enum(["node", "fleet"]),
  cooldownSec: z.number().int().min(0).max(86_400),
  enabled: z.boolean(),
  hasWebhook: z.boolean(),
});
export type HealthRule = z.infer<typeof healthRuleSchema>;

export const healthRulePutSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  threshold: z.number().optional(),
  severity: healthSeveritySchema.optional(),
  cooldownSec: z.number().int().min(0).max(86_400).optional(),
  enabled: z.boolean().optional(),
  /** Plaintext in, stored encrypted (ADR-0002); null clears the channel. */
  webhookUrl: z.string().url().max(500).nullable().optional(),
});
export type HealthRulePut = z.infer<typeof healthRulePutSchema>;

/** One open finding (per node). */
export const healthFindingSchema = z.object({
  nodeId: z.string().uuid(),
  ruleId: z.string().uuid(),
  metric: healthMetricSchema,
  severity: healthSeveritySchema,
  summary: z.string(),
  since: z.string().datetime({ offset: true }),
});
export type HealthFinding = z.infer<typeof healthFindingSchema>;

/** Threshold values the web consumes (seed-rule thresholds). */
export const healthThresholdsSchema = z.object({
  tempWarnC: z.number(),
  tempCriticalC: z.number(),
  diskWarnPct: z.number(),
});
export type HealthThresholds = z.infer<typeof healthThresholdsSchema>;

/**
 * The seed rule set (single source: the server seeds these on first boot and
 * the web falls back to the same values until the API answers). Metric →
 * meaning: gpu_temp_c (°C per GPU), disk_pct (used %), kernel_xid (count),
 * throttle_active (any reason), power_w (package power), node_offline,
 * telemetry_gap_s (seconds since last snapshot).
 */
export const HEALTH_SEED_RULES: Array<{
  name: string;
  metric: HealthMetric;
  op: "gte" | "lte" | "gt" | "lt" | "eq";
  threshold: number;
  severity: HealthSeverity;
  cooldownSec: number;
}> = [
  { name: "GPU temp warn", metric: "gpu_temp_c", op: "gte", threshold: 70, severity: "warn", cooldownSec: 600 },
  { name: "GPU temp critical", metric: "gpu_temp_c", op: "gte", threshold: 90, severity: "critical", cooldownSec: 600 },
  { name: "Disk usage warn", metric: "disk_pct", op: "gte", threshold: 80, severity: "warn", cooldownSec: 3600 },
  { name: "Kernel Xid", metric: "kernel_xid", op: "gt", threshold: 0, severity: "warn", cooldownSec: 3600 },
  { name: "Throttle active", metric: "throttle_active", op: "gt", threshold: 0, severity: "warn", cooldownSec: 1800 },
  { name: "Power envelope breach", metric: "power_w", op: "gt", threshold: 240, severity: "warn", cooldownSec: 1800 },
  { name: "Node offline", metric: "node_offline", op: "eq", threshold: 1, severity: "critical", cooldownSec: 600 },
  { name: "Telemetry gap", metric: "telemetry_gap_s", op: "gte", threshold: 15, severity: "warn", cooldownSec: 1800 },
  // IR-179: the 2026-11-04 incident produced ~10 node-online events per
  // minute for 78 minutes; a 30 s crash loop lands at exactly 10 per 5 min,
  // while deploy blips (1–2 reconnects) stay silent.
  { name: "Reconnect storm", metric: "reconnect_storm", op: "gte", threshold: 10, severity: "warn", cooldownSec: 600 },
];

/** Shared threshold values for the web (from the seed rules). */
export function seedThresholds(): HealthThresholds {
  const gpuWarn = HEALTH_SEED_RULES.find((r) => r.metric === "gpu_temp_c" && r.severity === "warn")!;
  const gpuCritical = HEALTH_SEED_RULES.find((r) => r.metric === "gpu_temp_c" && r.severity === "critical")!;
  const disk = HEALTH_SEED_RULES.find((r) => r.metric === "disk_pct")!;
  return { tempWarnC: gpuWarn.threshold, tempCriticalC: gpuCritical.threshold, diskWarnPct: disk.threshold };
}
