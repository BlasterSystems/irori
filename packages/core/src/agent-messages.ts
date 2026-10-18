import { z } from "zod";
import { hardwareSnapshotSchema } from "./snapshot.js";
import { llmMsgSchema } from "./llm.js";
import { jobRequestMsgSchema, jobCancelMsgSchema, catalogRequestMsgSchema } from "./job-messages.js";

/**
 * Agent → server messages. First frame on a connection MUST be hello;
 * the server replies hello-ok (or error and closes). Snapshots follow at
 * the cadence the server last sent via config-update (default 2000 ms).
 */
export const helloMsgSchema = z.object({
  type: z.literal("hello"),
  schemaVersion: z.number().int().nonnegative(),
  agentVersion: z.string().min(1),
  token: z.string().min(1),
  hostname: z.string().min(1),
});

export const snapshotMsgSchema = z.object({
  type: z.literal("snapshot"),
  snapshot: hardwareSnapshotSchema,
});

export const agentPingMsgSchema = z.object({ type: z.literal("ping"), t: z.number() });

export const agentMsgSchema = z.discriminatedUnion("type", [
  helloMsgSchema,
  snapshotMsgSchema,
  agentPingMsgSchema,
  llmMsgSchema,
]);

export type HelloMsg = z.infer<typeof helloMsgSchema>;
export type SnapshotMsg = z.infer<typeof snapshotMsgSchema>;
export type AgentMsg = z.infer<typeof agentMsgSchema>;

/** Server → agent messages. */
export const helloOkMsgSchema = z.object({
  type: z.literal("hello-ok"),
  nodeId: z.string().uuid(),
  cadenceMs: z.number().int().positive(),
  serverVersion: z.string().min(1),
});

export const configUpdateMsgSchema = z.object({
  type: z.literal("config-update"),
  cadenceMs: z.number().int().positive(),
  /** Per-node LLM ports to probe; empty = no probes. Role comes from the node record. */
  llmPorts: z
    .array(
      z.object({
        port: z.number().int().positive(),
        host: z.string().min(1).default("127.0.0.1"),
      }),
    )
    .default([]),
  /** 0 = probes disabled; used for worker detection-only cadence override. */
  llmCadenceMs: z.number().int().nonnegative().default(0),
  /** Workers send detection-only probes (backend/model, no rate windows). */
  llmDetectOnly: z.boolean().default(false),
  /** NAS store root for model-ops nodes (M4); null otherwise. */
  nasRoot: z.string().nullable().default(null),
});

export const serverErrorMsgSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const serverPongMsgSchema = z.object({ type: z.literal("pong"), t: z.number() });

export const serverMsgSchema = z.discriminatedUnion("type", [
  helloOkMsgSchema,
  configUpdateMsgSchema,
  serverErrorMsgSchema,
  serverPongMsgSchema,
  jobRequestMsgSchema,
  jobCancelMsgSchema,
  catalogRequestMsgSchema,
]);

export type HelloOkMsg = z.infer<typeof helloOkMsgSchema>;
export type ConfigUpdateMsg = z.infer<typeof configUpdateMsgSchema>;
export type ServerMsg = z.infer<typeof serverMsgSchema>;
