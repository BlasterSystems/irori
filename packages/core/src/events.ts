import { z } from "zod";
import { hardwareSnapshotSchema } from "./snapshot.js";

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

export const sseEventSchema = z.discriminatedUnion("type", [
  snapshotEventSchema,
  nodeStatusEventSchema,
  heartbeatEventSchema,
]);

export type SnapshotEvent = z.infer<typeof snapshotEventSchema>;
export type NodeStatusEvent = z.infer<typeof nodeStatusEventSchema>;
export type HeartbeatEvent = z.infer<typeof heartbeatEventSchema>;
export type SseEvent = z.infer<typeof sseEventSchema>;
