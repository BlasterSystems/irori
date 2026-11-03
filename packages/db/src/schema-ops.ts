import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { nodes } from "./schema.js";

/**
 * Fleet-operations and observability tables (audit, logs, health rules, alerts,
 * recipe catalog, community items, update reports). Kept apart from schema.ts
 * so this cluster is reviewable as one unit. Same conventions: bigserial rings,
 * ts + node indexes, retention-bounded growth.
 */

/**
 * Durable audit log (IRI-077). One row per mutating hub route, recorded
 * before dispatch for dispatched actions. `before`/`after` are redacted by
 * the audit service — secret material never reaches these columns.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /** hub | agent | client | anonymous */
    actor: text("actor").notNull(),
    actorDetail: text("actor_detail"),
    /** domain.verb, e.g. `node.delete`. */
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    summary: text("summary").notNull().default(""),
    before: jsonb("before"),
    after: jsonb("after"),
    /** ok | error */
    outcome: text("outcome").notNull().default("ok"),
    error: text("error"),
    requestId: text("request_id"),
    sourceAddr: text("source_addr"),
  },
  (t) => [
    index("audit_log_ts_idx").on(t.ts),
    index("audit_log_action_idx").on(t.action, t.ts),
    index("audit_log_target_idx").on(t.targetType, t.targetId),
    index("audit_log_actor_idx").on(t.actor, t.ts),
  ],
);

/**
 * Captured events whose payload failed the hub schema (IRI-070). The old path
 * dropped them while still acking the id, so the agent deleted the row:
 * silent, unrecoverable loss of billing-grade data. Quarantine keeps the raw
 * payload so drift is diagnosable instead of invisible.
 */
export const rejectedUsage = pgTable(
  "rejected_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Capture id when the event carried one — the dedupe key against llm_requests. */
    captureId: text("capture_id"),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    setupId: uuid("setup_id"),
    /** Raw event as received; kept for diagnosis, pruned with the table. */
    payload: jsonb("payload").notNull(),
    /** Zod issue summary: `path: message` joined, bounded. */
    reason: text("reason").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rejected_usage_received_idx").on(t.receivedAt), index("rejected_usage_node_idx").on(t.nodeId, t.receivedAt)],
);

/**
 * Durable structured logs (IRI-078). The agent's ring and the SSE feed are
 * caches; this is the record. `seq` is monotonic per (setupId, runId) so a
 * tail can resume without gaps; `dropped` rows count queue overflow.
 */
export const logs = pgTable(
  "logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /** Agent wall clock, advisory (same convention as llm_requests.ts). */
    eventTs: bigint("event_ts", { mode: "number" }).notNull(),
    /** setup | job | agent | proxy | hub */
    scope: text("scope").notNull(),
    setupId: uuid("setup_id"),
    runId: text("run_id"),
    jobId: text("job_id"),
    /** trace | debug | info | warn | error */
    level: text("level").notNull().default("info"),
    /** driver | engine | proxy | system */
    source: text("source").notNull().default("system"),
    seq: bigint("seq", { mode: "number" }),
    line: text("line").notNull(),
  },
  (t) => [
    index("logs_node_ts_idx").on(t.nodeId, t.ts),
    index("logs_setup_ts_idx").on(t.setupId, t.ts),
    index("logs_level_ts_idx").on(t.level, t.ts),
    uniqueIndex("logs_run_seq_uq").on(t.setupId, t.runId, t.seq).where(sql`seq is not null`),
  ],
);

/** Queue-overflow counter per node (IRI-078): makes truncation visible, not silent. */
export const logDropCounters = pgTable(
  "log_drop_counters",
  {
    nodeId: uuid("node_id")
      .primaryKey()
      .references(() => nodes.id, { onDelete: "cascade" }),
    dropped: bigint("dropped", { mode: "number" }).notNull().default(0),
    lastDropAt: timestamp("last_drop_at", { withTimezone: true }),
  },
);

/** Health-findings rules (IRI-069). Server-side thresholds; the web tier reads truth. */
export const healthRules = pgTable(
  "health_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Built-in seed key (idempotent seeding); null for user rules. */
    seed: text("seed"),
    name: text("name").notNull(),
    metric: text("metric").notNull(),
    /** gt | gte | lt | lte */
    op: text("op").notNull().default("gt"),
    threshold: real("threshold"),
    /** info | warn | critical */
    severity: text("severity").notNull().default("warn"),
    /** node | fleet */
    scope: text("scope").notNull().default("node"),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    cooldownSec: integer("cooldown_sec").notNull().default(900),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("health_rules_seed_uq").on(t.seed).where(sql`seed is not null`), index("health_rules_enabled_idx").on(t.enabled)],
);

/**
 * Active findings (appear without a clear) plus their last-notification time,
 * which is what makes the cooldown enforceable across restarts.
 */
export const healthFindings = pgTable(
  "health_findings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => healthRules.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
    /** Resolved node for fleet-scope rules (the node that breached). */
    observedValue: real("observed_value"),
    since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  },
  (t) => [
    index("health_findings_open_idx").on(t.clearedAt, t.since),
    index("health_findings_rule_idx").on(t.ruleId, t.nodeId),
  ],
);

/** Alert channels (IRI-069). The webhook URL lives in `secrets` (ADR-0002). */
export const alertChannels = pgTable(
  "alert_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    ruleId: uuid("rule_id").references(() => healthRules.id, { onDelete: "cascade" }),
    /** secrets row id holding the webhook URL; null = unset. */
    urlSecretId: uuid("url_secret_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alert_channels_enabled_idx").on(t.enabled)],
);

/** Recent delivery attempts — enough to answer "did I get notified and why not". */
export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => alertChannels.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => healthRules.id, { onDelete: "set null" }),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** appear | clear */
    kind: text("kind").notNull(),
    ok: boolean("ok").notNull().default(false),
    status: integer("status"),
    error: text("error"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alert_deliveries_ts_idx").on(t.ts), index("alert_deliveries_channel_idx").on(t.channelId, t.ts)],
);

/** Curated recipe catalog (IRI-082). Pinned upstream provenance, never vendored copyleft bodies. */
export const recipeCatalog = pgTable(
  "recipe_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    author: text("author").notNull(),
    /** miaai-script | sparkrun-transpiled */
    kind: text("kind").notNull(),
    /** tensorfold | vllm | sglang | llama.cpp | other */
    engine: text("engine").notNull(),
    summary: text("summary").notNull().default(""),
    upstreamUrl: text("upstream_url").notNull(),
    commitSha: text("commit_sha").notNull(),
    license: text("license").notNull(),
    copyleft: boolean("copyleft").notNull().default(false),
    defaultPort: integer("default_port").notNull().default(8888),
    modelRepo: text("model_repo"),
    modelRevision: text("model_revision"),
    envKeys: jsonb("env_keys").notNull().default(sql`'[]'::jsonb`),
    nodeCountMin: integer("node_count_min").notNull().default(1),
    nodeCountMax: integer("node_count_max").notNull().default(1),
    scriptStart: text("script_start").notNull().default("start.sh"),
    scriptStop: text("script_stop").notNull().default("stop.sh"),
    provenance: jsonb("provenance"),
    startupTimeoutMs: integer("startup_timeout_ms").notNull().default(600000),
    releaseNotesUrl: text("release_notes_url"),
    forumTopicId: text("forum_topic_id"),
    measured: jsonb("measured").notNull().default(sql`'[]'::jsonb`),
    catalogVersion: integer("catalog_version").notNull().default(1),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    hidden: boolean("hidden").notNull().default(false),
    curated: boolean("curated").notNull().default(true),
    behindCommits: integer("behind_commits"),
    engineReleasesBehind: integer("engine_releases_behind"),
  },
  (t) => [uniqueIndex("recipe_catalog_slug_uq").on(t.slug), index("recipe_catalog_kind_idx").on(t.kind, t.hidden)],
);

/**
 * Community items (IRI-083). Immutable per (source, externalId); topics are
 * derived, never stored, so a keyword change re-derives without a migration.
 */
export const communityItems = pgTable(
  "community_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    score: integer("score"),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    hidden: boolean("hidden").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    seen: boolean("seen").notNull().default(false),
    /** x-post rows store identity only; bodies hydrate at view time. */
    embedOnly: boolean("embed_only").notNull().default(false),
    /** Conditional-GET token when the source provides one. */
    etag: text("etag"),
  },
  (t) => [
    uniqueIndex("community_items_uq").on(t.source, t.externalId),
    index("community_items_pub_idx").on(t.publishedAt),
    index("community_items_view_idx").on(t.source, t.hidden, t.publishedAt),
  ],
);

/** Per-source poll health — the degraded chip and the circuit breaker's memory. */
export const communitySources = pgTable(
  "community_sources",
  {
    source: text("source").primaryKey(),
    ok: boolean("ok").notNull().default(true),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    failures: integer("failures").notNull().default(0),
    /** Set when the breaker opened; polling stops until the next probe. */
    breakerOpenUntil: timestamp("breaker_open_until", { withTimezone: true }),
    etag: text("etag"),
    note: text("note"),
  },
);

/**
 * On-node OS/firmware truth (IRI-081), reported by the agent on the same
 * channel as inventory. One row per node; the hub diffs it against the
 * scraped baseline.
 */
export const nodeUpdateReports = pgTable(
  "node_update_reports",
  {
    nodeId: uuid("node_id")
      .primaryKey()
      .references(() => nodes.id, { onDelete: "cascade" }),
    report: jsonb("report").notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Durable fleet event journal (IRI-077). The SSE recording feed is a
 * 500-frame in-memory ring lost on restart; this is the record of operational
 * facts (job transitions, thermal/usage events, setup state) that survives a
 * deploy. Same frame types the feed keeps — the excluded high-rate streams
 * (snapshot/llm/job-progress/setup-log/heartbeat) are never journaled.
 */
export const eventJournal = pgTable(
  "event_journal",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /** SseEvent discriminator: job | thermal | usage | setup | bench … */
    type: text("type").notNull(),
    nodeId: text("node_id"),
    payload: jsonb("payload").notNull(),
  },
  (t) => [index("event_journal_ts_idx").on(t.ts), index("event_journal_type_ts_idx").on(t.type, t.ts)],
);

/** Hub-cached NVIDIA release-notes baseline; last-known-good on scrape failure. */
export const updateBaselineCache = pgTable("update_baseline_cache", {
  id: integer("id").primaryKey().default(1),
  baseline: jsonb("baseline").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  stale: boolean("stale").notNull().default(false),
});
