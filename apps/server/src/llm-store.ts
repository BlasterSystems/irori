import { and, desc, eq, lt } from "drizzle-orm";
import { llmBuckets, llmSnapshots, nodes, type NodeRecord } from "@irori/db";
import type { Db } from "@irori/db";
import { llmPortAssignmentSchema, type LlmPortAssignment } from "@irori/core";
import type { Granularity } from "./rollups.js";

/**
 * LLM probe persistence for apps/server (M3). Canonical home is packages/db
 * next to NodeStore — kept here because extending packages/db is outside
 * M3's scope (reported to Main; move later). Mirrors NodeStore's snapshot
 * functions on the raw drizzle handle: fire-and-forget inserts, counted
 * prunes, bucket deletes for retention.
 */
export interface LlmStore {
  /** Inserts one probe pass; `payload` is `{ schemaVersion, agentVersion, ports }`. */
  insertLlmSnapshot(nodeId: string, payload: unknown): Promise<void>;
  /** Deletes raw llm snapshots older than `olderThan`; returns the deleted count. */
  pruneLlmSnapshots(olderThan: Date): Promise<number>;
  /** Deletes llm buckets of one granularity older than `keepDays`; returns the deleted count. */
  pruneLlmBuckets(granularity: Granularity, keepDays: number): Promise<number>;
  /** Latest persisted probe pass for a node (server-receive time + ports), or null. */
  latestLlmSnapshot(nodeId: string): Promise<LlmSnapshotRow | null>;
  /** Replaces the node's probe assignments: plain ports probed on 127.0.0.1. */
  setNodeLlmPorts(nodeId: string, ports: number[]): Promise<void>;
}

export interface LlmSnapshotRow {
  serverTimeMs: number;
  ports: unknown[];
}

export function createLlmStore(db: Db): LlmStore {
  return {
    async insertLlmSnapshot(nodeId, payload) {
      await db.insert(llmSnapshots).values({ nodeId, payload });
    },

    async pruneLlmSnapshots(olderThan) {
      const deleted = await db
        .delete(llmSnapshots)
        .where(lt(llmSnapshots.serverTime, olderThan))
        .returning({ id: llmSnapshots.id });
      return deleted.length;
    },

    async pruneLlmBuckets(granularity, keepDays) {
      const cutoff = new Date(Date.now() - keepDays * 86_400_000);
      const deleted = await db
        .delete(llmBuckets)
        .where(and(eq(llmBuckets.granularity, granularity), lt(llmBuckets.bucketStart, cutoff)))
        .returning({ id: llmBuckets.id });
      return deleted.length;
    },

    async latestLlmSnapshot(nodeId) {
      const [row] = await db
        .select({ serverTime: llmSnapshots.serverTime, payload: llmSnapshots.payload })
        .from(llmSnapshots)
        .where(eq(llmSnapshots.nodeId, nodeId))
        .orderBy(desc(llmSnapshots.serverTime), desc(llmSnapshots.id))
        .limit(1);
      if (!row) return null;
      const payload: unknown = row.payload;
      const ports =
        typeof payload === "object" && payload !== null && "ports" in payload ? payload.ports : undefined;
      return {
        serverTimeMs: row.serverTime.getTime(),
        ports: Array.isArray(ports) ? ports : [],
      };
    },

    async setNodeLlmPorts(nodeId, ports) {
      const assignments = ports.map((port) => ({ port, host: "127.0.0.1" }));
      await db
        .update(nodes)
        .set({ llmPorts: assignments, updatedAt: new Date() })
        .where(eq(nodes.id, nodeId));
    },
  };
}

/**
 * Validates a node row's `llmPorts` jsonb into probe assignments. The column
 * is untyped jsonb, so garbage is filtered out instead of trusted.
 */
export function nodeLlmAssignments(row: NodeRecord | null | undefined): LlmPortAssignment[] {
  const raw = row?.llmPorts;
  if (!Array.isArray(raw)) return [];
  const out: LlmPortAssignment[] = [];
  for (const item of raw) {
    const parsed = llmPortAssignmentSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
