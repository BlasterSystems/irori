import { createHash } from "node:crypto";

/**
 * IR-55: sha256 hex of the presented bearer token — the raw key is never
 * stored or logged anywhere; only the fingerprint reaches the server, which
 * matches it against issued client identities. Lives in packages/proxy (not
 * core) because core is bundled into the browser, which must not pull in
 * node:crypto.
 */
export function bearerKeyHash(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  if (token === undefined || token.length === 0) return null;
  return createHash("sha256").update(token, "utf8").digest("hex");
}
