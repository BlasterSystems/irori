import { z } from "zod";
import { hardwareSnapshotSchema } from "./snapshot.js";
import { llmEventSchema, type LlmEvent } from "./llm.js";
import { usageRequestSchema } from "./usage.js";

export type { LlmEvent };

/**
 * Server → browser event hub (SSE, GET /api/v1/events). All events carry a
 * server monotonic receive timestamp for bucketing (ADR-0006).
 */
export const snapshotEventSchema = z.object({
  type: z.literal("snapshot"),
  serverTimeMs: z.number(),
  nodeId: z.string().uuid(),
  snapshot: hardwareSnapshotSchema,
});

export const nodeStatusEventSchema = z.object({
  type: z.literal("node-online").or(z.literal("node-offline")),
  serverTimeMs: z.number(),
  nodeId: z.string().uuid(),
  agentVersion: z.string().nullable(),
});

export const heartbeatEventSchema = z.object({
  type: z.literal("heartbeat"),
  serverTimeMs: z.number(),
});

/** Setup driver/health state changed (M5). */
export const setupStateEventSchema = z.object({
  type: z.literal("setup-state"),
  serverTimeMs: z.number(),
  setupId: z.string().uuid(),
  status: z.enum(["stopped", "starting", "running", "stopping", "failed"]),
  health: z.enum(["starting", "healthy", "foreign", "timeout"]).nullable(),
  lastError: z.string().nullable(),
});

/** One staged-transfer stage changed or progressed (M5). */
export const setupTransferEventSchema = z.object({
  type: z.literal("setup-transfer"),
  serverTimeMs: z.number(),
  setupId: z.string().uuid(),
  transferId: z.string().uuid(),
  stageIndex: z.number().int().nonnegative(),
  stageCount: z.number().int().positive(),
  label: z.string(),
  nodeId: z.string().uuid(),
  jobId: z.string().uuid().nullable(),
  status: z.enum(["pending", "queued", "running", "succeeded", "failed", "canceled", "skipped"]),
  progress: z
    .object({
      bytes: z.number().nullable(),
      percent: z.number().nullable(),
      rateBytesPerSec: z.number().nullable(),
      etaSeconds: z.number().nullable(),
    })
    .nullable(),
});

/** Bench run started/progressed/finished (M6). */
export const benchEventSchema = z.object({
  type: z.literal("bench"),
  serverTimeMs: z.number(),
  runId: z.string().uuid(),
  bench: z.enum(["decode", "prefill", "quality", "tooleval"]),
  nodeId: z.string().uuid(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  progress: z
    .object({
      phase: z.string(),
      index: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      label: z.string(),
      liveTps: z.number().nullable(),
    })
    .nullable(),
});

/** Terminal job settlement (M4/M5 jobs) — one frame per settled job. */
export const jobEventSchema = z.object({
  type: z.literal("job"),
  serverTimeMs: z.number(),
  nodeId: z.string().uuid(),
  jobId: z.string().uuid(),
  kind: z.string(),
  status: z.enum(["succeeded", "failed", "canceled"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nullable(),
});

/** GPU throttle-reason set changed for one card — computed server-side from
 *  consecutive snapshot diffs; `active` empty means the last reason cleared. */
export const thermalEventSchema = z.object({
  type: z.literal("thermal"),
  serverTimeMs: z.number(),
  nodeId: z.string().uuid(),
  gpuIndex: z.number().int().nonnegative(),
  active: z.array(z.string()),
});

/** One captured LLM request (M8) — sent after durable Postgres insert. */
export const usageEventSchema = z.object({
  type: z.literal("usage"),
  serverTimeMs: z.number(),
  nodeId: z.string().uuid(),
  request: usageRequestSchema,
});

export const sseEventSchema = z.discriminatedUnion("type", [
  snapshotEventSchema,
  nodeStatusEventSchema,
  heartbeatEventSchema,
  llmEventSchema,
  setupStateEventSchema,
  setupTransferEventSchema,
  benchEventSchema,
  jobEventSchema,
  thermalEventSchema,
  usageEventSchema,
]);

export type SnapshotEvent = z.infer<typeof snapshotEventSchema>;
export type NodeStatusEvent = z.infer<typeof nodeStatusEventSchema>;
export type HeartbeatEvent = z.infer<typeof heartbeatEventSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
export type SetupStateEvent = z.infer<typeof setupStateEventSchema>;
export type SetupTransferEvent = z.infer<typeof setupTransferEventSchema>;
export type BenchEvent = z.infer<typeof benchEventSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type ThermalEvent = z.infer<typeof thermalEventSchema>;
export type UsageEvent = z.infer<typeof usageEventSchema>;
