import { z } from "zod";

/**
 * Health findings rules engine, alert channels and the Prometheus gate
 * (IRI-069, epic IR-157 WS1). Rules are evaluated server-side on snapshot
 * ingest (ADR-0006) — the web tier never holds thresholds, so a finding is
 * one number in one place.
 */

export const RULE_METRICS = [
  "gpuTempC",
  "gpuPowerW",
  "cpuTempC",
  "diskUsedPct",
  "telemetryGapS",
  "offline",
  "gpuThrottled",
  "kernelXidCount",
  "kernelOomCount",
  "queueDepth",
] as const;
export const ruleMetricSchema = z.enum(RULE_METRICS);
export type RuleMetric = z.infer<typeof ruleMetricSchema>;

export const RULE_OPS = ["gt", "gte", "lt", "lte"] as const;
export const ruleOpSchema = z.enum(RULE_OPS);
export type RuleOp = z.infer<typeof ruleOpSchema>;

export const FINDING_SEVERITIES = ["info", "warn", "critical"] as const;
export const findingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const RULE_SCOPES = ["node", "fleet"] as const;
export const ruleScopeSchema = z.enum(RULE_SCOPES);
export type RuleScope = z.infer<typeof ruleScopeSchema>;

/** A rule as stored; `threshold` is meaningless for boolean metrics (offline, throttled). */
export const healthRuleSchema = z.object({
  id: z.string().uuid(),
  /** Stable seed key for built-in rules ("gpu-temp-warn"); user rules are null. */
  seed: z.string().max(64).nullable().default(null),
  name: z.string().min(1).max(96),
  metric: ruleMetricSchema,
  op: ruleOpSchema.default("gt"),
  threshold: z.number().nullable().default(null),
  severity: findingSeveritySchema,
  scope: ruleScopeSchema.default("node"),
  /** Null-scoped node for scope=node rules; null = every node. */
  nodeId: z.string().uuid().nullable().default(null),
  /** Seconds between repeat notifications of the same appear (default 900). */
  cooldownSec: z.number().int().positive().max(86_400).default(900),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HealthRule = z.infer<typeof healthRuleSchema>;

export const healthRuleCreateSchema = healthRuleSchema.omit({ id: true, seed: true, createdAt: true, updatedAt: true });
export type HealthRuleCreate = z.infer<typeof healthRuleCreateSchema>;
export const healthRulePatchSchema = healthRuleCreateSchema.partial();
export type HealthRulePatch = z.infer<typeof healthRulePatchSchema>;

/** A currently-active finding on a node (appear without a matching clear). */
export const nodeFindingSchema = z.object({
  ruleId: z.string().uuid(),
  ruleName: z.string(),
  severity: findingSeveritySchema,
  metric: ruleMetricSchema,
  /** Observed value at appear time (null for boolean metrics). */
  value: z.number().nullable(),
  threshold: z.number().nullable(),
  since: z.string(),
});
export type NodeFinding = z.infer<typeof nodeFindingSchema>;

export const healthRulesResponseSchema = z.object({ rules: z.array(healthRuleSchema) });
export type HealthRulesResponse = z.infer<typeof healthRulesResponseSchema>;
export const nodeFindingsResponseSchema = z.object({
  nodeId: z.string().uuid(),
  findings: z.array(nodeFindingSchema),
});
export type NodeFindingsResponse = z.infer<typeof nodeFindingsResponseSchema>;

/** Alert channel: one webhook URL per channel, secret stored in `secrets` (ADR-0002). */
export const alertChannelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(96),
  /** Rule id or null = all rules. */
  ruleId: z.string().uuid().nullable().default(null),
  enabled: z.boolean().default(true),
  /** True when a URL is stored; the URL itself never leaves the secrets table. */
  hasUrl: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AlertChannel = z.infer<typeof alertChannelSchema>;

export const alertChannelCreateSchema = z.object({
  name: z.string().min(1).max(96),
  ruleId: z.string().uuid().nullable().default(null),
  webhookUrl: z.string().url().max(2048),
  enabled: z.boolean().default(true),
});
export type AlertChannelCreate = z.infer<typeof alertChannelCreateSchema>;

/** Last delivery attempts, newest first (bounded window, not a queue). */
export const alertDeliverySchema = z.object({
  /** Decimal string: Postgres BIGINT, JSON-safe on the wire (BigInt is not). */
  id: z.string().regex(/^\d+$/),
  channelId: z.string().uuid(),
  ruleId: z.string().uuid(),
  nodeId: z.string().uuid().nullable(),
  kind: z.enum(["appear", "clear"]),
  ok: z.boolean(),
  status: z.number().int().nullable(),
  error: z.string().nullable(),
  ts: z.string(),
});
export type AlertDelivery = z.infer<typeof alertDeliverySchema>;

export const alertChannelsResponseSchema = z.object({
  channels: z.array(alertChannelSchema),
  deliveries: z.array(alertDeliverySchema),
});
export type AlertChannelsResponse = z.infer<typeof alertChannelsResponseSchema>;

/** Settings rows: Prometheus export gate. Off by default (SPEC §14). */
export const prometheusSettingsSchema = z.object({ enabled: z.boolean() });
export type PrometheusSettings = z.infer<typeof prometheusSettingsSchema>;
export const prometheusSettingsResponseSchema = z.object({ prometheus: prometheusSettingsSchema.nullable() });
export type PrometheusSettingsResponse = z.infer<typeof prometheusSettingsResponseSchema>;

/**
 * The generic webhook payload. Shaped so Discord/Slack-compatible wrappers
 * are trivial downstream; the delivery is a plain JSON POST.
 */
export const alertWebhookPayloadSchema = z.object({
  source: z.literal("irori"),
  kind: z.enum(["appear", "clear"]),
  severity: findingSeveritySchema,
  rule: z.string(),
  metric: ruleMetricSchema,
  value: z.number().nullable(),
  threshold: z.number().nullable(),
  node: z.string().nullable(),
  ts: z.string(),
});
export type AlertWebhookPayload = z.infer<typeof alertWebhookPayloadSchema>;
