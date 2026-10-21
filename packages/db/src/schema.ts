import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bigserial,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres bytea ↔ Node Buffer (postgres-js driver, IR-52 body parts). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const nodeKind = pgEnum("node_kind", ["spark", "gpu-host", "nas"]);
export const nodeRole = pgEnum("node_role", ["head", "worker", "standalone"]);

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: nodeKind("kind").notNull(),
    role: nodeRole("role").notNull(),
    host: text("host").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** SHA-256 hex of the current agent token — O(1) lookup on hello. */
    agentTokenHash: text("agent_token_hash").notNull(),
    /** AES-256-GCM ciphertext of the current agent token (ADR-0002). */
    agentTokenEnc: text("agent_token_enc").notNull(),
    agentVersion: text("agent_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    /** LLM ports this node serves (agent probes them; M3). */
    llmPorts: jsonb("llm_ports").notNull().default(sql`'[]'::jsonb`),
    /** NAS store root for model-ops nodes (M4); null otherwise. */
    nasRoot: text("nas_root"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("nodes_name_uq").on(t.name),
    index("nodes_agent_token_hash_idx").on(t.agentTokenHash),
  ],
);

/**
 * Raw snapshot ring (ADR-0006). The in-memory ring is the live view; this is
 * the history source. Prune job bounds growth (M2 adds rollups).
 */
export const snapshots = pgTable(
  "snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    serverTime: timestamp("server_time", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [index("snapshots_node_time_idx").on(t.nodeId, t.serverTime)],
);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Pre-aggregated snapshot buckets (ADR-0006). Watermark-guarded, idempotent:
 * recompute always covers buckets >= the stored watermark. Temps keep
 * min/avg/max (SPEC §4); other metrics average. `samples` counts merged rows.
 */
export const bucketGranularity = pgEnum("bucket_granularity", ["minute", "hour", "day"]);

export const snapshotBuckets = pgTable(
  "snapshot_buckets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    granularity: bucketGranularity("granularity").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    samples: integer("samples").notNull().default(0),
    cpuUsagePct: real("cpu_usage_pct"),
    cpuTempC: real("cpu_temp_c"),
    cpuTempMinC: real("cpu_temp_min_c"),
    cpuTempMaxC: real("cpu_temp_max_c"),
    packagePowerW: real("package_power_w"),
    memUsedBytes: doublePrecision("mem_used_bytes"),
    memTotalBytes: doublePrecision("mem_total_bytes"),
    gpuUsagePct: real("gpu_usage_pct"),
    gpuTempC: real("gpu_temp_c"),
    gpuTempMinC: real("gpu_temp_min_c"),
    gpuTempMaxC: real("gpu_temp_max_c"),
    gpuPowerW: real("gpu_power_w"),
    gpuMemUsedBytes: doublePrecision("gpu_mem_used_bytes"),
    netRxBps: doublePrecision("net_rx_bps"),
    netTxBps: doublePrecision("net_tx_bps"),
    /** Any GPU in the bucket reported a throttle reason (temps lens markers). */
    gpuThrottled: boolean("gpu_throttled"),
  },
  (t) => [uniqueIndex("snapshot_buckets_uq").on(t.nodeId, t.granularity, t.bucketStart)],
);

/** Raw LLM probe snapshots (same ring/retention model as `snapshots`). */
export const llmSnapshots = pgTable(
  "llm_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    serverTime: timestamp("server_time", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull(),
  },
  (t) => [index("llm_snapshots_node_time_idx").on(t.nodeId, t.serverTime)],
);

/** Pre-aggregated LLM buckets (watermark-guarded, same model as snapshotBuckets). */
export const llmBuckets = pgTable(
  "llm_buckets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    port: integer("port").notNull(),
    granularity: bucketGranularity("granularity").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    samples: integer("samples").notNull().default(0),
    decodeTps: doublePrecision("decode_tps"),
    prefillTps: doublePrecision("prefill_tps"),
    queueRunning: real("queue_running"),
    queueWaiting: real("queue_waiting"),
    kvCachePct: real("kv_cache_pct"),
    ttftP95Ms: real("ttft_p95_ms"),
  },
  (t) => [uniqueIndex("llm_buckets_uq").on(t.nodeId, t.port, t.granularity, t.bucketStart)],
);

/** Jobs subsystem: one active job per node (409 otherwise), M4. */
export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "canceled"]);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    params: jsonb("params").notNull().default(sql`'{}'::jsonb`),
    exitCode: integer("exit_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_node_idx").on(t.nodeId, t.createdAt),
    // Enforces one-active-per-node under concurrency (the service's
    // check-then-insert alone races; 23505 maps to the 409 busy error).
    uniqueIndex("jobs_node_active_uq").on(t.nodeId).where(sql`status IN ('queued', 'running')`),
  ],
);

/** Job output ring (last N lines, streamed to the UI). */
export const jobOutput = pgTable(
  "job_output",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    line: text("line").notNull(),
  },
  (t) => [index("job_output_job_seq_idx").on(t.jobId, t.seq)],
);

/** Model metadata cache (HF join + cards), keyed by model name. */
export const modelMeta = pgTable("model_meta", {
  name: text("name").primaryKey(),
  repository: text("repository").notNull(),
  runtime: text("runtime").notNull(),
  bytes: doublePrecision("bytes").notNull().default(0),
  /** HF revision, quantization, companions, card summary — agent-supplied JSON. */
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  /** When Irori first saw the model (catalog read); drives "recently added" sort. */
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Which node's local HF cache holds which model (maintained by job completions). */
export const nodeModels = pgTable(
  "node_models",
  {
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "node_models_node_id_model_pk", columns: [t.nodeId, t.model] })],
);

/** Generic secret store (SSH credentials, future per-node material). */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    valueEnc: text("value_enc").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("secrets_name_uq").on(t.name)],
);

/**
 * Download queue (IRI-014): one row per requested HF download. Entries batch
 * into a single `download-queue` job on the store node (NAS-preferred) when
 * it is idle; batch outcomes reconcile back onto these rows.
 */
export const downloadQueueStatusEnum = pgEnum("download_queue_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "removed",
]);

export const downloadQueue = pgTable(
  "download_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** HF repo id or URL. */
    source: text("source").notNull(),
    /** Store name passed to modelctl (labels in batch output match this). */
    name: text("name").notNull(),
    status: downloadQueueStatusEnum("status").notNull().default("pending"),
    /** Batch job that carried the entry; null until first dispatch. */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** Batch concurrency for the entry; a dispatch uses the batch max. */
    jobs: integer("jobs").notNull().default(4),
    /** Failure detail (batch output reconcile). */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("download_queue_status_idx").on(t.status, t.createdAt)],
);

/** Serving setups (M5): one start/stop script pair on the head (SPEC §7). */
export const setupStatusEnum = pgEnum("setup_status", ["stopped", "starting", "running", "stopping", "failed"]);
export const setupHealthEnum = pgEnum("setup_health", ["starting", "healthy", "foreign", "timeout"]);

export const setups = pgTable(
  "setups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    /** Script-defined serving port on the head (probed for health, env PORT). */
    port: integer("port").notNull(),
    headNodeId: uuid("head_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** Cluster workers beyond the head: [{nodeId, role}] (core setupNodeSchema). */
    nodes: jsonb("nodes").notNull().default(sql`'[]'::jsonb`),
    scriptStart: text("script_start").notNull(),
    scriptStop: text("script_stop").notNull(),
    /** Optional env exports (core envExportsSchema). */
    env: jsonb("env").notNull().default(sql`'{}'::jsonb`),
    /** M8: engine traffic served through the agent capture proxy (ADR-0008). */
    captureProxy: boolean("capture_proxy").notNull().default(false),
    /** IR-52: store deduped request/response bodies for captured requests. */
    bodyRetention: boolean("body_retention").notNull().default(false),
    status: setupStatusEnum("status").notNull().default("stopped"),
    health: setupHealthEnum("health"),
    lastError: text("last_error"),
    startupTimeoutMs: integer("startup_timeout_ms").notNull().default(15 * 60 * 1000),
    lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("setups_head_idx").on(t.headNodeId)],
);

/** Agent-side driver runs: pid/pgid/log path recorded per start. */
export const setupRunStatusEnum = pgEnum("setup_run_status", ["running", "exited", "stopped", "failed", "canceled"]);

export const setupRuns = pgTable(
  "setup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    setupId: uuid("setup_id")
      .notNull()
      .references(() => setups.id, { onDelete: "cascade" }),
    status: setupRunStatusEnum("status").notNull().default("running"),
    exitCode: integer("exit_code"),
    pid: integer("pid"),
    pgid: integer("pgid"),
    logPath: text("log_path"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("setup_runs_setup_idx").on(t.setupId, t.startedAt)],
);

/** Staged transfer runs (wizard placement): chained M4 jobs, stages in jsonb. */
export const setupTransfers = pgTable(
  "setup_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    setupId: uuid("setup_id")
      .notNull()
      .references(() => setups.id, { onDelete: "cascade" }),
    stages: jsonb("stages").notNull().default(sql`'[]'::jsonb`),
    status: jobStatusEnum("status").notNull().default("running"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("setup_transfers_setup_idx").on(t.setupId, t.createdAt)],
);

/** Benchmarks (M6, SPEC §8): agent-run results per node, pruned to the last 30 per type. */
export const benchTypeEnum = pgEnum("bench_type", ["decode", "prefill", "quality", "tooleval"]);
export const benchStatusEnum = pgEnum("bench_status", ["running", "completed", "failed", "canceled"]);

export const benchRuns = pgTable(
  "bench_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: benchTypeEnum("type").notNull(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    status: benchStatusEnum("status").notNull().default("running"),
    /** Per-type config (core bench config schemas). */
    config: jsonb("config").notNull(),
    /** Type-shaped result (core bench result schemas); null until completed. */
    result: jsonb("result"),
    error: text("error"),
    model: text("model"),
    port: integer("port"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("bench_runs_type_idx").on(t.type, t.createdAt),
    index("bench_runs_node_idx").on(t.nodeId, t.createdAt),
    // Enforces one-active-per-node under concurrency (23505 → BenchBusyError).
    uniqueIndex("bench_runs_node_running_uq").on(t.nodeId).where(sql`status = 'running'`),
  ],
);

/**
 * Token ledger (M7, SPEC §9): cumulative probe counters diffed per
 * (node, port, model) into hourly/daily deltas. Columns stay NULL when the
 * backend never published that counter in the bucket — coverage, never a
 * zero guess. `cached` is a subset of `prompt` (prefix-cache hits).
 */
export const tokenLedger = pgTable(
  "token_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    port: integer("port").notNull(),
    /** Detected model id; "unknown" while the port is undetected. */
    model: text("model").notNull(),
    granularity: bucketGranularity("granularity").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    samples: integer("samples").notNull().default(0),
    generatedTokens: bigint("generated_tokens", { mode: "number" }).notNull().default(0),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    /** True when at least one sample in the bucket carried this counter. */
    generatedSeen: boolean("generated_seen").notNull().default(false),
    promptSeen: boolean("prompt_seen").notNull().default(false),
    cachedSeen: boolean("cached_seen").notNull().default(false),
  },
  (t) => [
    uniqueIndex("token_ledger_uq").on(t.nodeId, t.port, t.model, t.granularity, t.bucketStart),
    index("token_ledger_bucket_idx").on(t.granularity, t.bucketStart),
  ],
);

/**
 * Monthly energy archive (M7, SPEC §9). Estimated, never wall-metered:
 * gpu board + cpu package + base overhead, clamped to the GB10 system
 * envelope. Wh/token is computed at read time from the token ledger.
 */
export const energyMonthly = pgTable(
  "energy_monthly",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** UTC month start (YYYY-MM-01 00:00). */
    monthStart: timestamp("month_start", { withTimezone: true }).notNull(),
    samples: integer("samples").notNull().default(0),
    gpuWh: doublePrecision("gpu_wh"),
    cpuWh: doublePrecision("cpu_wh"),
    baseWh: doublePrecision("base_wh"),
    totalWh: doublePrecision("total_wh"),
    gpuCoverage: real("gpu_coverage"),
    cpuCoverage: real("cpu_coverage"),
  },
  (t) => [uniqueIndex("energy_monthly_uq").on(t.nodeId, t.monthStart)],
);

/** Disk-hygiene audit/clean runs (M7, SPEC §11.6): History tab (last 20 · 90 d). */
export const cleanupRuns = pgTable(
  "cleanup_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** "audit" | "clean". */
    kind: text("kind").notNull(),
    status: jobStatusEnum("status").notNull().default("running"),
    /** Requested categories (clean) — audit covers all eight. */
    categories: jsonb("categories").notNull().default(sql`'[]'::jsonb`),
    /** Structured per-category report (hygiene audit / clean result). */
    report: jsonb("report"),
    error: text("error"),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
    (t) => [index("cleanup_runs_node_idx").on(t.nodeId, t.createdAt)],
);

/**
 * Captured LLM requests (M8, ADR-0008). One row per proxied request, UUID
 * keyed for exactly-once sync (`ON CONFLICT DO NOTHING` on redelivery).
 * Bucketing keys on `receivedAt` (server ingest time, ADR-0006) — agent `ts`
 * is advisory. Raw retention 90 d.
 */
export const llmRequests = pgTable(
  "llm_requests",
  {
    id: uuid("id").primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    setupId: uuid("setup_id").references(() => setups.id, { onDelete: "set null" }),
    /** Client-facing port (the proxy listener). */
    port: integer("port").notNull(),
    /** Agent wall-clock request start (advisory). */
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    model: text("model"),
    endpoint: text("endpoint").notNull(),
    stream: boolean("stream").notNull().default(false),
    status: integer("status"),
    finishReason: text("finish_reason"),
    error: text("error"),
    /** Normalized error signature (core normalizeErrorSignature) for grouping. */
    errorSig: text("error_sig"),
    durationMs: integer("duration_ms"),
    ttftMs: integer("ttft_ms"),
    decodeTps: real("decode_tps"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    cachedTokens: integer("cached_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    totalTokens: integer("total_tokens"),
    /** Engine-internal metrics block (e.g. TensorFold), verbatim. */
    engineMeta: jsonb("engine_meta"),
    reqBytes: integer("req_bytes").notNull().default(0),
    resBytes: integer("res_bytes").notNull().default(0),
    sourceAddr: text("source_addr"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("llm_requests_node_received_idx").on(t.nodeId, t.receivedAt),
    index("llm_requests_model_idx").on(t.model, t.receivedAt),
    index("llm_requests_sig_idx").on(t.errorSig, t.receivedAt),
  ],
);

/**
 * Content-addressed body parts (IR-52): sha256-addressed gzip blobs referenced
 * by `llm_request_parts`. `refcount` counts referencing join rows; the prune
 * job decrements when owning `llm_requests` rows age out and deletes parts at
 * zero — deduped bodies die with their owning rows. Retention mirrors raw
 * requests (90 d from first store).
 */
export const llmParts = pgTable(
  "llm_parts",
  {
    /** sha256 hex of the canonical (uncompressed) part content. */
    hash: text("hash").primaryKey(),
    /** Original (uncompressed) byte length. */
    bytes: integer("bytes").notNull(),
    /** gzip(canonical bytes). */
    gz: bytea("gz").notNull(),
    /** True when partCapBytes cut the canonical content at capture. */
    truncated: boolean("truncated").notNull().default(false),
    /** Number of `llm_request_parts` rows referencing this part. */
    refcount: integer("refcount").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("llm_parts_created_idx").on(t.createdAt)],
);

/** Ordered part references per captured request (IR-52). */
export const llmRequestParts = pgTable(
  "llm_request_parts",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => llmRequests.id, { onDelete: "cascade" }),
    /** Ordinal within the request's stored part sequence. */
    ordinal: integer("ordinal").notNull(),
    hash: text("hash").notNull(),
    /** core usagePartWireSchema kinds: message|prompt|input|response|error|marker. */
    kind: text("kind").notNull(),
    /** OpenAI message role for `message` parts; null otherwise. */
    role: text("role"),
    /** Original (uncompressed) byte length of the part content. */
    bytes: integer("bytes").notNull(),
    truncated: boolean("truncated").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.ordinal] }), index("llm_request_parts_hash_idx").on(t.hash)],
);

/**
 * Pre-aggregated usage buckets (M8): hourly/daily rollups of `llm_requests`
 * per (node, model), watermark-guarded like snapshotBuckets. Model "" is the
 * unknown-model row (request without a parseable model). Retention 1 y.
 */
export const usageBuckets = pgTable(
  "usage_buckets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** Empty string = model unknown (not carried by the request). */
    model: text("model").notNull().default(""),
    granularity: bucketGranularity("granularity").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    requests: integer("requests").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull().default(0),
    completionTokens: bigint("completion_tokens", { mode: "number" }).notNull().default(0),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull().default(0),
    reasoningTokens: bigint("reasoning_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    ttftP50Ms: real("ttft_p50_ms"),
    ttftP95Ms: real("ttft_p95_ms"),
    durationP95Ms: real("duration_p95_ms"),
    /** Token-weighted mean decode tok/s (null when no decode window seen). */
    decodeTps: real("decode_tps"),
    /** Sum of completion-token weights behind decodeTps (for re-weighting). */
    decodeTpsWeight: bigint("decode_tps_weight", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    uniqueIndex("usage_buckets_uq").on(t.nodeId, t.model, t.granularity, t.bucketStart),
    index("usage_buckets_bucket_idx").on(t.granularity, t.bucketStart),
  ],
);
