import { z } from "zod";

/**
 * Durable structured logs (IRI-078, epic IR-157 WS4). The agent's setup log
 * ring and the hub's SSE feed are volatile caches; this is the record. One
 * `seq` per (setup, run) so a client can resume a tail without gaps, and a
 * level so an operator can ask "what went wrong" instead of "what scrolled
 * past". Emitters generate `eventId` (UUID); the hub's insert dedupes on it,
 * so buffer redelivery after a crash is a no-op (same pattern as the usage
 * buffer's client UUID, ADR-0008 §3).
 */

export const LOG_SCOPES = ["setup", "job", "agent", "proxy", "hub"] as const;
export const logScopeSchema = z.enum(LOG_SCOPES);
export type LogScope = z.infer<typeof logScopeSchema>;

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof logLevelSchema>;

/** Ascending severity index — the `level=` filter means "at least this". */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** The levels at or above `level` — SQL-safe `IN (...)` for the filter. */
export function levelsAtLeast(level: LogLevel): LogLevel[] {
  return LOG_LEVELS.slice(LOG_LEVEL_ORDER[level]);
}

/** Heuristic level for raw engine/driver output — the only cheap signal on
 *  unstructured stdout. Order matters: `OOM killed` is an error, not a warn. */
export function levelFromLine(line: string): LogLevel {
  if (/\b(error|fatal|panic|exception|traceback|oom|out of memory|killed|core dumped|abort)/i.test(line)) return "error";
  if (/\b(warn|warning|deprecated|retry|retrying|failed|refused|timeout|timed out)/i.test(line)) return "warn";
  if (/\b(debug|trace)\b/i.test(line)) return "debug";
  return "info";
}

/** Where the bytes came from — drives the Logs view's source filter. */
export const LOG_SOURCES = ["driver", "engine", "proxy", "system"] as const;
export const logSourceSchema = z.enum(LOG_SOURCES);
export type LogSource = z.infer<typeof logSourceSchema>;

/** One line, as emitted by the agent (or the hub, for hub-scope lines). */
export const logEventSchema = z.object({
  /** Emitter-generated dedupe key. */
  eventId: z.string().uuid(),
  /** Emitter wall clock (advisory ordering within a node). */
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

/** Max events per ship — sized well under the hub's WS `maxPayload` given the
 * 16 KiB per-line cap (worst case 8 MiB of lines in one frame). */
export const MAX_LOG_BATCH = 200;

/** Agent → server: one batched ship from the durable log buffer. The hub
 *  stamps `nodeId` from the authenticated connection (same trust rule as
 *  usage-batch: a rogue agent cannot forge another node's lines). */
export const logBatchMsgSchema = z.object({
  type: z.literal("log-batch"),
  schemaVersion: z.number().int().nonnegative(),
  agentVersion: z.string().min(1),
  events: z.array(logEventSchema).min(1).max(MAX_LOG_BATCH),
  /** Cumulative queue/buffer drops on the agent at ship time (the UI shows a
   *  truncated chip from this; no separate ping — piggyback keeps state 1:1
   *  with what the hub actually stored). */
  dropped: z.number().int().nonnegative().default(0),
});
export type LogBatchMsg = z.infer<typeof logBatchMsgSchema>;

/** Server → agent: durable insert succeeded for these event ids. */
export const logBatchAckMsgSchema = z.object({
  type: z.literal("log-batch-ack"),
  ids: z.array(z.string().uuid()).min(1),
});
export type LogBatchAckMsg = z.infer<typeof logBatchAckMsgSchema>;

/** A stored row as served by the API. `id` is the Postgres BIGINT (decimal
 *  string — BigInt is not JSON-safe) and doubles as the cursor/tail key. */
export const logRowSchema = z.object({
  id: z.string().regex(/^\d+$/),
  eventId: z.string().uuid(),
  nodeId: z.string().uuid(),
  ts: z.string().datetime({ offset: true }),
  eventTs: z.number().int().nonnegative(),
  scope: logScopeSchema,
  setupId: z.string().uuid().nullable(),
  runId: z.string().nullable(),
  jobId: z.string().nullable(),
  level: logLevelSchema,
  source: logSourceSchema,
  seq: z.number().int().nonnegative().nullable(),
  line: z.string(),
});
export type LogRow = z.infer<typeof logRowSchema>;

/** GET /api/v1/logs query. */
export const logRanges = ["15m", "1h", "6h", "24h", "7d", "30d"] as const;
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
  range: z.enum(logRanges).default("1h"),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  /** Backward pagination (id < cursor, newest first). */
  cursor: z.coerce.string().regex(/^\d+$/).optional(),
  /** Live-tail mode: rows with id > after, ASCENDING (page = the delta). */
  after: z.coerce.string().regex(/^\d+$/).optional(),
});
export type LogQuery = z.infer<typeof logQuerySchema>;

export const logPageSchema = z.object({
  rows: z.array(logRowSchema),
  nextCursor: z.string().regex(/^\d+$/).nullable(),
  /** Highest stored id in this page — the tail resume point. */
  latestId: z.string().regex(/^\d+$/).nullable(),
  /** True when lines were dropped by the agent queues in range. */
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
