import { z } from "zod";

/**
 * Durable structured logs (IRI-078, epic IR-157 WS4). The agent's setup log
 * ring and the hub's SSE feed are volatile caches; this is the record. One
 * `seq` per (setup, run) so a client can resume a tail without gaps, and a
 * level so an operator can ask "what went wrong" instead of "what scrolled
 * past".
 */

export const LOG_SCOPES = ["setup", "job", "agent", "proxy", "hub"] as const;
export const logScopeSchema = z.enum(LOG_SCOPES);
export type LogScope = z.infer<typeof logScopeSchema>;

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof logLevelSchema>;

/** Where the bytes came from — drives the Serve page's source filter. */
export const LOG_SOURCES = ["driver", "engine", "proxy", "system"] as const;
export const logSourceSchema = z.enum(LOG_SOURCES);
export type LogSource = z.infer<typeof logSourceSchema>;

/** One line, as emitted by the agent or the hub. */
export const logEventSchema = z.object({
  ts: z.number().int().nonnegative(),
  scope: logScopeSchema,
  setupId: z.string().uuid().nullable().default(null),
  /** Setup run id — the resume key for a run's log. */
  runId: z.string().nullable().default(null),
  jobId: z.string().nullable().default(null),
  level: logLevelSchema.default("info"),
  source: logSourceSchema.default("system"),
  /** Per (setup, run) monotonic counter; null for scopes without a run. */
  seq: z.number().int().nonnegative().nullable().default(null),
  line: z.string().max(16384),
});
export type LogEvent = z.infer<typeof logEventSchema>;

/** A batched ship from the agent (mirrors the usage-buffer ack pattern). */
export const logBatchSchema = z.object({
  nodeId: z.string().uuid(),
  events: z.array(logEventSchema).max(500),
});
export type LogBatch = z.infer<typeof logBatchSchema>;

export const logRowSchema = logEventSchema.extend({
  /** Decimal string: Postgres BIGINT, JSON-safe on the wire (BigInt is not). */
  id: z.string().regex(/^\d+$/),
  nodeId: z.string().uuid(),
});
export type LogRow = z.infer<typeof logRowSchema>;

/** GET /api/v1/logs query. */
export const logQuerySchema = z.object({
  nodeId: z.string().uuid().optional(),
  setupId: z.string().uuid().optional(),
  runId: z.string().max(64).optional(),
  jobId: z.string().max(64).optional(),
  scope: logScopeSchema.optional(),
  source: logSourceSchema.optional(),
  /** Inclusive minimum level (trace shows everything). */
  level: logLevelSchema.optional(),
  q: z.string().max(128).optional(),
  range: z.enum(["15m", "1h", "6h", "24h", "7d", "30d"]).default("1h"),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.coerce.string().regex(/^\d+$/).optional(),
});
export type LogQuery = z.infer<typeof logQuerySchema>;

export const logPageSchema = z.object({
  rows: z.array(logRowSchema),
  nextCursor: z.string().regex(/^\d+$/).nullable(),
  /** True when lines were dropped by the agent's bounded queue in range. */
  truncated: z.boolean().default(false),
});
export type LogPage = z.infer<typeof logPageSchema>;

/** GET /api/v1/logs/summary — counts by level for the filter bar chips. */
export const logSummarySchema = z.object({
  counts: z.record(logLevelSchema, z.number().int().nonnegative()),
  total: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
});
export type LogSummary = z.infer<typeof logSummarySchema>;
