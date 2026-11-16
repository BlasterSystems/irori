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
  /** IRI-068: Wake-on-LAN target MAC (aa:bb:cc:dd:ee:ff); null = cannot wake. */
  wolMac: z.string().regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i).nullable().default(null),
  /** IRI-068: GPU clock cap in MHz applied on the node; null = uncapped. */
  gpuClockCapMHz: z.number().int().min(300).max(4000).nullable().default(null),
  /** IRI-068: cap is re-applied at boot by a transient systemd unit. */
  gpuClockCapPersistent: z.boolean().default(false),
  /** IRI-124: CPU clock ceiling in MHz (cpufreq scaling_max_freq per policy);
   *  null = every policy at its own maximum. */
  cpuClockCapMHz: z.number().int().min(300).max(4000).nullable().default(null),
  /** IRI-124: CPU cap is re-applied at boot by a transient systemd unit. */
  cpuClockCapPersistent: z.boolean().default(false),
  /** IR-260: bundle generation state — the hub diffs the agent-reported
   *  sha256 of its own bundle file against the artifact it serves. */
  bundle: z
    .object({
      running: z.string().nullable(),
      expected: z.string().nullable(),
      state: z.enum(["current", "behind", "unknown"]),
    })
    .default({ running: null, expected: null, state: "unknown" }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type NodeInfo = z.infer<typeof nodeInfoSchema>;

/** IR-260: classify the agent-reported bundle hash against the served
 *  artifact. Either side unknown → "unknown" (old agents, or a hub with no
 *  artifact to compare — never a verdict). */
export function bundleState(
  running: string | null,
  expected: string | null,
): { running: string | null; expected: string | null; state: "current" | "behind" | "unknown" } {
  if (running === null || expected === null) return { running, expected, state: "unknown" };
  return { running, expected, state: running === expected ? "current" : "behind" };
}

/** Payload for POST /api/v1/nodes. */
export const nodeCreateSchema = nodeInfoSchema
  .pick({ name: true, kind: true, role: true, host: true, llmPorts: true, nasRoot: true, cacheUser: true, wolMac: true })
  .extend({ enabled: z.boolean().optional() });

/** Payload for PATCH /api/v1/nodes/:id. */
export const nodePatchSchema = nodeInfoSchema
  .pick({
    name: true,
    kind: true,
    role: true,
    host: true,
    enabled: true,
    sortOrder: true,
    llmPorts: true,
    nasRoot: true,
    cacheUser: true,
    wolMac: true,
  })
  .partial();

export type NodeCreateInput = z.infer<typeof nodeCreateSchema>;
export type NodePatchInput = z.infer<typeof nodePatchSchema>;

/** Wire payload for POST /api/v1/nodes: fields with defaults stay optional
 *  (builders use the INPUT type — z.infer makes defaulted keys REQUIRED). */
export type NodeCreatePayload = z.input<typeof nodeCreateSchema>;
/** Wire payload for PATCH /api/v1/nodes/:id (every key optional). */
export type NodePatchPayload = z.input<typeof nodePatchSchema>;

/* ── Role derivation (IRI-050) ──────────────────────────────────────────────
 * Roles follow serving-setup membership instead of hand maintenance: on every
 * membership-changing setup op the server re-derives roles over ALL setups
 * and writes only the diffs. Manual override (PATCH /nodes/:id) stays and is
 * simply overwritten the next time that node's membership changes. */

/** Minimal membership view: a setup's head plus its worker rows. Setups rows
 *  and SetupInfo both project onto this shape. */
export interface SetupMembership {
  headNodeId: string;
  nodes: ReadonlyArray<{ nodeId: string }>;
}

/**
 * Derives nodeId → role over the given setup set, defined only for
 * `nodeIds` (the existing node rows): `head` if the node is headNodeId of any
 * setup, else `worker` if it appears in any setup's worker list, else
 * `standalone`. Head-over-worker precedence resolves multi-membership (a node
 * may legally head setup A and serve as worker of setup B). Worker ids absent
 * from `nodeIds` (dangling, e.g. pre-hygiene jsonb) are ignored. Pure: same
 * inputs, same map, no I/O.
 */
export function deriveNodeRoles(
  setups: ReadonlyArray<SetupMembership>,
  nodeIds: ReadonlySet<string>,
): Map<string, NodeRole> {
  const roles = new Map<string, NodeRole>();
  for (const id of nodeIds) roles.set(id, "standalone");
  for (const setup of setups) {
    if (nodeIds.has(setup.headNodeId)) roles.set(setup.headNodeId, "head");
  }
  for (const setup of setups) {
    for (const member of setup.nodes) {
      // Dangling worker id (row no longer exists): ignored, never derived.
      if (!nodeIds.has(member.nodeId)) continue;
      if (roles.get(member.nodeId) !== "head") roles.set(member.nodeId, "worker");
    }
  }
  return roles;
}

/**
 * Write-only diff: the subset of `derived` whose role differs from
 * `current`. `scope` limits the comparison to the caller's affected set —
 * without it a setup op would also rewrite unrelated nodes' manual overrides
 * (e.g. a hand-marked head of a non-setup engine). Keys missing from
 * `current` count as changed (unknown current role).
 */
export function diffNodeRoles(
  derived: ReadonlyMap<string, NodeRole>,
  current: ReadonlyMap<string, NodeRole>,
  scope?: ReadonlySet<string>,
): Map<string, NodeRole> {
  const changed = new Map<string, NodeRole>();
  for (const [id, role] of derived) {
    if (scope !== undefined && !scope.has(id)) continue;
    if (current.get(id) !== role) changed.set(id, role);
  }
  return changed;
}
