import { desc, eq } from "drizzle-orm";
import { clientIdentities } from "@irori/db";
import type { Db } from "@irori/db";
import { clientAgentTypeSchema } from "@irori/core";
import { generateToken, sha256Hex } from "@irori/db";
import { invalidateIdentityCache } from "./usage-identity.js";

/**
 * IR-55 client-identity registry (ADR-0010 §8): homelab identification tags,
 * not auth. The generated key is returned exactly once (creation response);
 * only its sha256 is stored. Identity edits invalidate the ingest cache.
 */

export interface ClientIdentityInfo {
  id: string;
  name: string;
  project: string | null;
  agentType: "main" | "subagent" | null;
  keyHash: string | null;
  createdAtMs: number;
}

export interface UsageClients {
  list(): Promise<ClientIdentityInfo[]>;
  /** Creates an identity and returns it with the ONE-TIME plaintext key. */
  create(input: { name: string; project?: string | null; agentType?: "main" | "subagent" | null }): Promise<ClientIdentityInfo & { key: string }>;
  remove(id: string): Promise<boolean>;
}

const NAME_CAP = 120;
const PROJECT_CAP = 200;

export function createUsageClients(db: Db): UsageClients {
  const toInfo = (row: typeof clientIdentities.$inferSelect): ClientIdentityInfo => ({
    id: row.id,
    name: row.name,
    project: row.project,
    agentType: row.agentType === "main" || row.agentType === "subagent" ? row.agentType : null,
    keyHash: row.keyHash,
    createdAtMs: row.createdAt.getTime(),
  });
  return {
    async list() {
      const rows = await db.select().from(clientIdentities).orderBy(desc(clientIdentities.createdAt));
      return rows.map(toInfo);
    },

    async create(input) {
      const name = input.name.trim().slice(0, NAME_CAP);
      if (name.length === 0) throw new Error("name is required");
      const project = input.project === undefined ? null : (input.project?.trim().slice(0, PROJECT_CAP) || null);
      const agentType = input.agentType === undefined ? null : (clientAgentTypeSchema.safeParse(input.agentType).success ? input.agentType! : null);
      const key = generateToken();
      const [row] = await db
        .insert(clientIdentities)
        .values({ name, project, agentType, keyHash: sha256Hex(key) })
        .returning();
      if (!row) throw new Error("identity insert returned no row");
      invalidateIdentityCache();
      return { ...toInfo(row), key };
    },

    async remove(id) {
      const deleted = await db.delete(clientIdentities).where(eq(clientIdentities.id, id)).returning({ id: clientIdentities.id });
      if (deleted.length > 0) invalidateIdentityCache();
      return deleted.length > 0;
    },
  };
}
