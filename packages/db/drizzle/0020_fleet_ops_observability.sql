CREATE TABLE "alert_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"rule_id" uuid,
	"url_secret_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"rule_id" uuid,
	"node_id" uuid,
	"kind" text NOT NULL,
	"ok" boolean DEFAULT false NOT NULL,
	"status" integer,
	"error" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"actor_detail" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"summary" text DEFAULT '' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"request_id" text,
	"source_addr" text
);
--> statement-breakpoint
CREATE TABLE "community_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"author" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"embed_only" boolean DEFAULT false NOT NULL,
	"etag" text
);
--> statement-breakpoint
CREATE TABLE "community_sources" (
	"source" text PRIMARY KEY NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"breaker_open_until" timestamp with time zone,
	"etag" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "event_journal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"node_id" text,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_findings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"node_id" uuid,
	"observed_value" real,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "health_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seed" text,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"op" text DEFAULT 'gt' NOT NULL,
	"threshold" real,
	"severity" text DEFAULT 'warn' NOT NULL,
	"scope" text DEFAULT 'node' NOT NULL,
	"node_id" uuid,
	"cooldown_sec" integer DEFAULT 900 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_drop_counters" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"dropped" bigint DEFAULT 0 NOT NULL,
	"last_drop_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event_ts" bigint NOT NULL,
	"scope" text NOT NULL,
	"setup_id" uuid,
	"run_id" text,
	"job_id" text,
	"level" text DEFAULT 'info' NOT NULL,
	"source" text DEFAULT 'system' NOT NULL,
	"seq" bigint,
	"line" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_update_reports" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"report" jsonb NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"author" text NOT NULL,
	"kind" text NOT NULL,
	"engine" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"upstream_url" text NOT NULL,
	"commit_sha" text NOT NULL,
	"license" text NOT NULL,
	"copyleft" boolean DEFAULT false NOT NULL,
	"default_port" integer DEFAULT 8888 NOT NULL,
	"model_repo" text,
	"model_revision" text,
	"env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"node_count_min" integer DEFAULT 1 NOT NULL,
	"node_count_max" integer DEFAULT 1 NOT NULL,
	"script_start" text DEFAULT 'start.sh' NOT NULL,
	"script_stop" text DEFAULT 'stop.sh' NOT NULL,
	"provenance" jsonb,
	"startup_timeout_ms" integer DEFAULT 600000 NOT NULL,
	"release_notes_url" text,
	"forum_topic_id" text,
	"measured" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"catalog_version" integer DEFAULT 1 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"curated" boolean DEFAULT true NOT NULL,
	"behind_commits" integer,
	"engine_releases_behind" integer
);
--> statement-breakpoint
CREATE TABLE "rejected_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"capture_id" text,
	"node_id" uuid,
	"setup_id" uuid,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "update_baseline_cache" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"baseline" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stale" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "span_id" text;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "prefill_ms" integer;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "decode_ms" integer;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "spec_rounds" integer;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "spec_drafted" integer;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "spec_accepted" integer;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "wol_mac" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "gpu_clock_cap_mhz" integer;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "gpu_clock_cap_persistent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_buckets" ADD COLUMN "cost_minor" bigint;--> statement-breakpoint
ALTER TABLE "usage_buckets" ADD COLUMN "cost_currency" text;--> statement-breakpoint
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_rule_id_health_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."health_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_channel_id_alert_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."alert_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_rule_id_health_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."health_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_findings" ADD CONSTRAINT "health_findings_rule_id_health_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."health_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_findings" ADD CONSTRAINT "health_findings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_rules" ADD CONSTRAINT "health_rules_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_drop_counters" ADD CONSTRAINT "log_drop_counters_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logs" ADD CONSTRAINT "logs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_update_reports" ADD CONSTRAINT "node_update_reports_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejected_usage" ADD CONSTRAINT "rejected_usage_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_channels_enabled_idx" ON "alert_channels" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "alert_deliveries_ts_idx" ON "alert_deliveries" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "alert_deliveries_channel_idx" ON "alert_deliveries" USING btree ("channel_id","ts");--> statement-breakpoint
CREATE INDEX "audit_log_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","ts");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "community_items_uq" ON "community_items" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "community_items_pub_idx" ON "community_items" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "community_items_view_idx" ON "community_items" USING btree ("source","hidden","published_at");--> statement-breakpoint
CREATE INDEX "event_journal_ts_idx" ON "event_journal" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "event_journal_type_ts_idx" ON "event_journal" USING btree ("type","ts");--> statement-breakpoint
CREATE INDEX "health_findings_open_idx" ON "health_findings" USING btree ("cleared_at","since");--> statement-breakpoint
CREATE INDEX "health_findings_rule_idx" ON "health_findings" USING btree ("rule_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "health_rules_seed_uq" ON "health_rules" USING btree ("seed") WHERE seed is not null;--> statement-breakpoint
CREATE INDEX "health_rules_enabled_idx" ON "health_rules" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "logs_node_ts_idx" ON "logs" USING btree ("node_id","ts");--> statement-breakpoint
CREATE INDEX "logs_setup_ts_idx" ON "logs" USING btree ("setup_id","ts");--> statement-breakpoint
CREATE INDEX "logs_level_ts_idx" ON "logs" USING btree ("level","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "logs_run_seq_uq" ON "logs" USING btree ("setup_id","run_id","seq") WHERE seq is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_catalog_slug_uq" ON "recipe_catalog" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "recipe_catalog_kind_idx" ON "recipe_catalog" USING btree ("kind","hidden");--> statement-breakpoint
CREATE INDEX "rejected_usage_received_idx" ON "rejected_usage" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "rejected_usage_node_idx" ON "rejected_usage" USING btree ("node_id","received_at");--> statement-breakpoint
CREATE INDEX "llm_requests_trace_idx" ON "llm_requests" USING btree ("trace_id");