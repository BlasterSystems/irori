import { sql } from "drizzle-orm";
import {
  boolean,
  bigserial,
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
  (t) => [index("jobs_node_idx").on(t.nodeId, t.createdAt)],
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

/** Advisory-lock key shared by every boot migration run. */
export const MIGRATE_LOCK_KEY = sql`hashtext('irori-migrate')`;
