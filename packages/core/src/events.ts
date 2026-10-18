import { z } from "zod";
import { hardwareSnapshotSchema } from "./snapshot.js";
import { llmEventSchema, type LlmEvent } from "./llm.js";

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

export const sseEventSchema = z.discriminatedUnion("type", [
  snapshotEventSchema,
  nodeStatusEventSchema,
  heartbeatEventSchema,
  llmEventSchema,
  setupStateEventSchema,
  setupTransferEventSchema,
]);

export type SnapshotEvent = z.infer<typeof snapshotEventSchema>;
export type NodeStatusEvent = z.infer<typeof nodeStatusEventSchema>;
export type HeartbeatEvent = z.infer<typeof heartbeatEventSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
export type SetupStateEvent = z.infer<typeof setupStateEventSchema>;
export type SetupTransferEvent = z.infer<typeof setupTransferEventSchema>;
