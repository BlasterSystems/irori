import { eq } from "drizzle-orm";
import type { Db } from "@irori/db";
import { nodeInventory } from "@irori/db";
import { nodeInventorySchema, type NodeInventory } from "@irori/core";

/**
 * Per-node model inventory reads (IRI-028). The report is written by
 * jobs-service when a `models-inventory` job settles and deleted whenever a
 * model-mutating job settles; this service only reads the cache.
 */
export interface InventoryEntry {
  report: NodeInventory;
  updatedAt: string;
}

export interface InventoryService {
  get(nodeId: string): Promise<InventoryEntry | null>;
}

export function createInventoryService(db: Db): InventoryService {
  return {
    async get(nodeId) {
      const [row] = await db
        .select({ report: nodeInventory.report, updatedAt: nodeInventory.updatedAt })
        .from(nodeInventory)
        .where(eq(nodeInventory.nodeId, nodeId))
        .limit(1);
      if (row === undefined) return null;
      const parsed = nodeInventorySchema.safeParse(row.report);
      if (!parsed.success) return null; // corrupt cache row → treat as absent
      return { report: parsed.data, updatedAt: row.updatedAt.toISOString() };
    },
  };
}
