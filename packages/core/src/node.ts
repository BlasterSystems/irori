import { z } from "zod";

export const NODE_KINDS = ["spark", "gpu-host", "nas"] as const;
export const NODE_ROLES = ["head", "worker", "standalone"] as const;

export const nodeKindSchema = z.enum(NODE_KINDS);
export const nodeRoleSchema = z.enum(NODE_ROLES);

export type NodeKind = z.infer<typeof nodeKindSchema>;
export type NodeRole = z.infer<typeof nodeRoleSchema>;

/** Valid POSIX username for the node's cache owner (IR-101). The agent puts it
 *  into a runuser argv — no shell — but the shape stays strict anyway. */
export const CACHE_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

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
  /** IR-101: cache owner for transfers; null = the agent's own user (root). */
  cacheUser: z.string().regex(CACHE_USER_PATTERN).nullable().default(null),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type NodeInfo = z.infer<typeof nodeInfoSchema>;

/** Payload for POST /api/v1/nodes. */
export const nodeCreateSchema = nodeInfoSchema
  .pick({ name: true, kind: true, role: true, host: true, llmPorts: true, nasRoot: true, cacheUser: true })
  .extend({ enabled: z.boolean().optional() });

/** Payload for PATCH /api/v1/nodes/:id. */
export const nodePatchSchema = nodeInfoSchema
  .pick({ name: true, kind: true, role: true, host: true, enabled: true, sortOrder: true, llmPorts: true, nasRoot: true, cacheUser: true })
  .partial();

export type NodeCreateInput = z.infer<typeof nodeCreateSchema>;
export type NodePatchInput = z.infer<typeof nodePatchSchema>;

/** Wire payload for POST /api/v1/nodes: fields with defaults stay optional
 *  (builders use the INPUT type — z.infer makes defaulted keys REQUIRED). */
export type NodeCreatePayload = z.input<typeof nodeCreateSchema>;
/** Wire payload for PATCH /api/v1/nodes/:id (every key optional). */
export type NodePatchPayload = z.input<typeof nodePatchSchema>;
