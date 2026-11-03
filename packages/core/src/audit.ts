import { z } from "zod";
import { sseEventSchema } from "./events.js";

/**
 * Durable audit log (IRI-077, epic IR-157 WS4). Every mutating hub route
 * records one row: who did what to what, with the before/after shape that
 * made it inspectable after the fact. The SSE feed ring is a cache; this is
 * the record.
 *
 * Redaction is a contract, not a convention: `before`/`after` must never
 * carry secret material. Callers pass an allowlisted summary and the secret
 * value is replaced with its presence marker.
 */

/** `domain.verb`, e.g. `node.delete`, `setup.start`, `settings.token-cost.put`. */
export const auditActionSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "action must be domain.verb (lowercase, dot-separated)");

export const AUDIT_OUTCOMES = ["ok", "error"] as const;
export const auditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

/** Who acted: the hub itself, an agent, an issued client key, or an anonymous caller. */
export const AUDIT_ACTORS = ["hub", "agent", "client", "anonymous"] as const;
export const auditActorSchema = z.enum(AUDIT_ACTORS);
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditEntrySchema = z.object({
  /** Decimal string: Postgres BIGINT, JSON-safe on the wire (BigInt is not). */
  id: z.string().regex(/^\d+$/),
  ts: z.string(),
  actor: auditActorSchema,
  /** Node id, agent id, client key hash… whatever identifies this actor. */
  actorDetail: z.string().nullable(),
  action: auditActionSchema,
  /** Table/entity domain: `node`, `setup`, `settings`, `usage-client`… */
  targetType: z.string().min(1).max(64),
  targetId: z.string().nullable(),
  /** One-line human-readable summary; never contains secret values. */
  summary: z.string().max(512),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  outcome: auditOutcomeSchema,
  error: z.string().nullable(),
  /** Hub request id when the action came through HTTP. */
  requestId: z.string().nullable(),
  sourceAddr: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** GET /api/v1/audit query. Cursor is the descending `id` of the last row shown. */
export const AUDIT_RANGES = ["1h", "24h", "7d", "30d", "90d", "1y"] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number];

export const auditQuerySchema = z.object({
  range: z.enum(AUDIT_RANGES).default("7d"),
  actor: auditActorSchema.optional(),
  action: z.string().max(96).optional(),
  /** Filter on the domain part of the action, e.g. `setup`. */
  domain: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
  q: z.string().max(128).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.coerce.string().regex(/^\d+$/).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditPageSchema = z.object({
  entries: z.array(auditEntrySchema),
  nextCursor: z.string().regex(/^\d+$/).nullable(),
  /** Total rows matching the filter, ignoring cursor (bounded count). */
  total: z.number().int().nonnegative(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

/**
 * Secret-bearing key names that must never reach `before`/`after`. Matched
 * after normalizing the key to lowercase alphanumerics, so `hfToken`,
 * `hf_token` and `HF-Token` all hit the same entry. Deliberately NOT a
 * suffix/substring sweep: `value`, `modelPath` and friends are legitimate
 * audit content, and over-redaction makes the record useless.
 */
export const AUDIT_REDACTED_KEYS = [
  "token",
  "hftoken",
  "password",
  "secret",
  "secrets",
  "apikey",
  "privatekey",
  "webhookurl",
  "agenttoken",
  "sshpasword",
  "sshpassword",
  "bearertoken",
  "accesskey",
  "credential",
  "credentials",
  "authorization",
  "raw",
] as const;

/** What a redacted value looks like in a stored summary. */
export const AUDIT_REDACTED = "***";

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
const REDACT_SET: ReadonlySet<string> = new Set(AUDIT_REDACTED_KEYS);

/** True when a key names something that must never be persisted in an audit row. */
export function isAuditRedactedKey(key: string): boolean {
  return REDACT_SET.has(normalizeKey(key));
}

/**
 * Deep-copy `value` with secret-looking keys replaced by {@link AUDIT_REDACTED}.
 * Depth- and breadth-bounded so a pathological payload cannot make auditing
 * expensive; oversized strings are truncated rather than stored whole.
 */
export function redactAuditValue(value: unknown, maxDepth = 6, maxArrayItems = 50): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > maxDepth) return "[max-depth]";
    if (typeof v === "string") return v.length > 4096 ? `${v.slice(0, 4096)}…[truncated]` : v;
    if (Array.isArray(v)) {
      const items = v.slice(0, maxArrayItems).map((item) => walk(item, depth + 1));
      if (v.length > maxArrayItems) items.push(`[${v.length - maxArrayItems} more]`);
      return items;
    }
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isAuditRedactedKey(k) && raw !== null && raw !== undefined ? AUDIT_REDACTED : walk(raw, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

/**
 * Durable event journal read contract (IRI-077). Rows are the verbatim SSE
 * frames persisted at emit time — `payload` is validated as the same
 * discriminated `sseEventSchema` the live feed carries.
 */
export const eventJournalRowSchema = z.object({
  id: z.string().regex(/^\d+$/),
  ts: z.string(),
  type: z.string().min(1).max(64),
  nodeId: z.string().nullable(),
  payload: sseEventSchema,
});
export type EventJournalRowWire = z.infer<typeof eventJournalRowSchema>;

export const eventJournalPageSchema = z.object({
  events: z.array(eventJournalRowSchema),
  /** Descending numeric id of the last row shown (number on the wire). */
  nextCursor: z.number().int().positive().nullable(),
});
export type EventJournalPageWire = z.infer<typeof eventJournalPageSchema>;
