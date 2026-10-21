import { inArray } from "drizzle-orm";
import { clientIdentities } from "@irori/db";
import type { Db } from "@irori/db";
import type { ClientAgentType } from "@irori/core";

/**
 * IR-55 key → identity resolution at ingest. One query per batch (never per
 * event) with a short TTL cache; a miss is normal (unidentified client) and
 * costs nothing.
 */

interface IdentityRow {
  name: string;
  project: string | null;
  agentType: ClientAgentType | null;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; identity: IdentityRow | null }>();

function evictExpired(now: number): void {
  for (const [hash, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(hash);
  }
}

/** Resolves key hashes to identities; misses map to null (source-IP fallback). */
export async function resolveIdentities(db: Db, keyHashes: string[]): Promise<Map<string, IdentityRow | null>> {
  const now = Date.now();
  evictExpired(now);
  const resolved = new Map<string, IdentityRow | null>();
  const missing: string[] = [];
  for (const hash of keyHashes) {
    const hit = cache.get(hash);
    if (hit !== undefined) resolved.set(hash, hit.identity);
    else missing.push(hash);
  }
  if (missing.length > 0) {
    const rows = await db
      .select({ keyHash: clientIdentities.keyHash, name: clientIdentities.name, project: clientIdentities.project, agentType: clientIdentities.agentType })
      .from(clientIdentities)
      .where(inArray(clientIdentities.keyHash, missing));
    const found = new Map(rows.filter((r) => r.keyHash !== null).map((r) => [r.keyHash as string, { name: r.name, project: r.project, agentType: r.agentType as ClientAgentType | null }]));
    for (const hash of missing) {
      const identity = found.get(hash) ?? null;
      cache.set(hash, { at: now, identity });
      resolved.set(hash, identity);
    }
  }
  return resolved;
}

/** Drops cached resolutions (identity edits) so the next batch re-reads. */
export function invalidateIdentityCache(): void {
  cache.clear();
}
