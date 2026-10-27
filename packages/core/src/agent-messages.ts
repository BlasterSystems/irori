import { z } from "zod";
import { CACHE_USER_PATTERN } from "./node.js";
import { MODELCTL_PIN_RE } from "./modelctl-pin.js";
import { hardwareSnapshotSchema } from "./snapshot.js";
import { llmMsgSchema } from "./llm.js";
import { benchRunRequestMsgSchema, benchCancelRequestMsgSchema } from "./bench.js";
import { jobRequestMsgSchema, jobCancelMsgSchema, catalogRequestMsgSchema, setupAckMsgSchema, setupStartMsgSchema, setupStopMsgSchema, setupStatusMsgSchema, setupLogAttachMsgSchema, setupValidateMsgSchema } from "./job-messages.js";
import { usageBatchAckMsgSchema } from "./usage.js";

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
  setupAckMsgSchema,
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
  /** IR-101: cache owner for transfers; null = the agent's own user (root). */
  cacheUser: z.string().regex(CACHE_USER_PATTERN).nullable().default(null),
  /**
   * IRI-019: global HF token (ADR-0009 addendum). string = set, null =
   * clear (agent falls back to its env), absent = no change (old server, or
   * a hub read failure — the key is omitted). Older agents strip the field;
   * the token never rides job params or job-output frames.
   */
  hfToken: z.string().min(1).nullish(),
  /**
   * IR-105: hub-pinned modelctl version agents converge to. string = use it
   * for install jobs and the version gate, null = clear (the agent's env pin
   * applies again), absent = no change. Older agents strip the field.
   */
  modelctlPin: z.string().regex(MODELCTL_PIN_RE).nullish(),
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
  benchRunRequestMsgSchema,
  benchCancelRequestMsgSchema,
  setupStartMsgSchema,
  setupStopMsgSchema,
  setupStatusMsgSchema,
  setupLogAttachMsgSchema,
  setupValidateMsgSchema,
  usageBatchAckMsgSchema,
]);

export type HelloOkMsg = z.infer<typeof helloOkMsgSchema>;
export type ConfigUpdateMsg = z.infer<typeof configUpdateMsgSchema>;
export type ServerMsg = z.infer<typeof serverMsgSchema>;
