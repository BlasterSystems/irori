CREATE TABLE "llm_buckets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"port" integer NOT NULL,
	"granularity" "bucket_granularity" NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"decode_tps" double precision,
	"prefill_tps" double precision,
	"queue_running" real,
	"queue_waiting" real,
	"kv_cache_pct" real,
	"ttft_p95_ms" real
);
--> statement-breakpoint
CREATE TABLE "llm_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "llm_ports" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_buckets" ADD CONSTRAINT "llm_buckets_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_snapshots" ADD CONSTRAINT "llm_snapshots_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_buckets_uq" ON "llm_buckets" USING btree ("node_id","port","granularity","bucket_start");--> statement-breakpoint
CREATE INDEX "llm_snapshots_node_time_idx" ON "llm_snapshots" USING btree ("node_id","server_time");