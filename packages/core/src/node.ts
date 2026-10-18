import { z } from "zod";

export const NODE_KINDS = ["spark", "gpu-host", "nas"] as const;
export const NODE_ROLES = ["head", "worker", "standalone"] as const;

export const nodeKindSchema = z.enum(NODE_KINDS);
export const nodeRoleSchema = z.enum(NODE_ROLES);

export type NodeKind = z.infer<typeof nodeKindSchema>;
export type NodeRole = z.infer<typeof nodeRoleSchema>;

/** Node registry entry as exposed by the API (never includes secrets). */
export const nodeInfoSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  kind: nodeKindSchema,
  role: nodeRoleSchema,
  host: z.string().min(1).max(255),
  enabled: z.boolean(),
  agentVersion: z.string().nullable(),
  online: z.boolean(),
  lastSeenAt: z.string().datetime({ offset: true }).nullable(),
  sortOrder: z.number().int(),
  /** LLM ports the agent probes on this node (M3). */
  llmPorts: z.array(z.number().int().positive()).default([]),
  /** NAS store root for model-ops nodes, e.g. /mnt/nas (M4); null otherwise. */
  nasRoot: z.string().nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type NodeInfo = z.infer<typeof nodeInfoSchema>;

/** Payload for POST /api/v1/nodes. */
export const nodeCreateSchema = nodeInfoSchema
  .pick({ name: true, kind: true, role: true, host: true, llmPorts: true, nasRoot: true })
  .extend({ enabled: z.boolean().optional() });

/** Payload for PATCH /api/v1/nodes/:id. */
export const nodePatchSchema = nodeInfoSchema
  .pick({ name: true, kind: true, role: true, host: true, enabled: true, sortOrder: true, llmPorts: true, nasRoot: true })
  .partial();

export type NodeCreateInput = z.infer<typeof nodeCreateSchema>;
export type NodePatchInput = z.infer<typeof nodePatchSchema>;
