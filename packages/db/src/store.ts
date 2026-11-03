import { and, eq, lt, sql } from "drizzle-orm";
import { nodes, setups, snapshots } from "./schema.js";
import type { Db } from "./client.js";
import type { NodeCreateInput, NodePatchInput } from "@irori/core";
import { encryptSecret, generateToken, sha256Hex } from "./crypto.js";

export interface CreatedNode {
  id: string;
  /** Plaintext token — returned exactly once, at creation/rotation. */
  token: string;
}

export interface NodeStore {
  list(): Promise<NodeRecord[]>;
  get(id: string): Promise<NodeRecord | null>;
  create(input: NodeCreateInput): Promise<CreatedNode>;
  patch(id: string, patch: NodePatchInput): Promise<void>;
  remove(id: string): Promise<void>;
  rotateToken(id: string): Promise<CreatedNode>;
  /** Node id for a presented agent token, or null (disabled nodes never match). */
  verifyToken(token: string): Promise<string | null>;
  markSeen(nodeId: string, agentVersion: string): Promise<void>;
  /**
   * IRI-068: record the GPU clock cap the node is now running with. Separate
   * from patch() because it is a consequence of a dispatched action (the
   * agent's answer), not an operator-editable node field.
   */
  setGpuClockCap(nodeId: string, capMHz: number | null, persistent: boolean): Promise<void>;
  insertSnapshot(nodeId: string, payload: unknown): Promise<void>;
  pruneSnapshots(olderThan: Date): Promise<number>;
  countSnapshots(nodeId: string): Promise<number>;
}

/** Node row without secret columns — safe to hand to the server layer. */
export type NodeRecord = Omit<typeof nodes.$inferSelect, "agentTokenHash" | "agentTokenEnc">;

const nodeRecordColumns = {
  id: nodes.id,
  name: nodes.name,
  kind: nodes.kind,
  role: nodes.role,
  host: nodes.host,
  enabled: nodes.enabled,
  agentVersion: nodes.agentVersion,
  lastSeenAt: nodes.lastSeenAt,
  sortOrder: nodes.sortOrder,
  llmPorts: nodes.llmPorts,
  nasRoot: nodes.nasRoot,
  cacheUser: nodes.cacheUser,
  // IRI-068: power control state (WOL target + GPU clock cap).
  wolMac: nodes.wolMac,
  gpuClockCapMHz: nodes.gpuClockCapMHz,
  gpuClockCapPersistent: nodes.gpuClockCapPersistent,
  createdAt: nodes.createdAt,
  updatedAt: nodes.updatedAt,
} satisfies Record<keyof NodeRecord, unknown>;

export function createNodeStore(db: Db, encryptionKey: string): NodeStore {
  const tokenPair = (token: string) => ({
    agentTokenHash: sha256Hex(token),
    agentTokenEnc: encryptSecret(encryptionKey, token),
  });

  return {
    async list() {
      return db.select(nodeRecordColumns).from(nodes).orderBy(nodes.sortOrder, nodes.name);
    },

    async get(id) {
      const [row] = await db.select(nodeRecordColumns).from(nodes).where(eq(nodes.id, id)).limit(1);
      return row ?? null;
    },

    async create(input) {
      const token = generateToken();
      const [row] = await db
        .insert(nodes)
        .values({
          name: input.name,
          kind: input.kind,
          role: input.role,
          host: input.host,
          enabled: input.enabled ?? true,
          // The create contract accepts both (core nodeCreateSchema) — persist
          // them or a "model-ops NAS root" create silently yields neither.
          llmPorts: (input.llmPorts ?? []).map((p) => ({ port: p, host: "127.0.0.1" })),
          nasRoot: input.nasRoot ?? null,
          cacheUser: input.cacheUser ?? null,
          wolMac: input.wolMac ? input.wolMac.toLowerCase() : null,
          ...tokenPair(token),
        })
        .returning({ id: nodes.id });
      if (!row) throw new Error("node insert returned no row");
      return { id: row.id, token };
    },

    async patch(id, patch) {
      const { llmPorts, ...rest } = patch;
      await db
        .update(nodes)
        .set({
          ...rest,
          // The wire contract is number[]; the store shape is {port, host}.
          // Coerce here so nodeLlmAssignments (config-update) keeps probing
          // instead of silently dropping plain numbers.
          ...(llmPorts !== undefined ? { llmPorts: llmPorts.map((p) => ({ port: p, host: "127.0.0.1" })) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(nodes.id, id));
    },

    async remove(id) {
      // IR-138: the FK cascades only setups the node heads; setups where it
      // was a WORKER would keep the dead uuid in their nodes jsonb forever
      // (ghost worker rows on setup cards). Strip it in the same transaction
      // so surviving setups stay parseable through setupNodeSchema.
      await db.transaction(async (tx) => {
        await tx.delete(nodes).where(eq(nodes.id, id));
        const rows = await tx.select({ id: setups.id, nodes: setups.nodes }).from(setups);
        for (const row of rows) {
          const members = Array.isArray(row.nodes) ? (row.nodes as Array<{ nodeId?: unknown }>) : [];
          const kept = members.filter((m) => m?.nodeId !== id);
          if (kept.length === members.length) continue;
          await tx.update(setups).set({ nodes: kept, updatedAt: new Date() }).where(eq(setups.id, row.id));
        }
      });
    },

    async rotateToken(id) {
      const token = generateToken();
      const [row] = await db
        .update(nodes)
        .set({ ...tokenPair(token), updatedAt: new Date() })
        .where(eq(nodes.id, id))
        .returning({ id: nodes.id });
      if (!row) throw new Error("node not found");
      return { id: row.id, token };
    },

    async verifyToken(token) {
      const [row] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.agentTokenHash, sha256Hex(token)), eq(nodes.enabled, true)))
        .limit(1);
      return row?.id ?? null;
    },

    async markSeen(nodeId, agentVersion) {
      await db
        .update(nodes)
        .set({ agentVersion, lastSeenAt: new Date(), updatedAt: new Date() })
        .where(eq(nodes.id, nodeId));
    },

    async setGpuClockCap(nodeId, capMHz, persistent) {
      await db
        .update(nodes)
        .set({ gpuClockCapMHz: capMHz, gpuClockCapPersistent: persistent, updatedAt: new Date() })
        .where(eq(nodes.id, nodeId));
    },

    async insertSnapshot(nodeId, payload) {
      await db.insert(snapshots).values({ nodeId, payload });
    },

    async pruneSnapshots(olderThan) {
      const deleted = await db
        .delete(snapshots)
        .where(lt(snapshots.serverTime, olderThan))
        .returning({ id: snapshots.id });
      return deleted.length;
    },

    async countSnapshots(nodeId) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(snapshots)
        .where(eq(snapshots.nodeId, nodeId));
      return row?.n ?? 0;
    },
  };
}
