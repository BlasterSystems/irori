CREATE TABLE "llm_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"setup_id" uuid,
	"port" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"model" text,
	"endpoint" text NOT NULL,
	"stream" boolean DEFAULT false NOT NULL,
	"status" integer,
	"finish_reason" text,
	"error" text,
	"error_sig" text,
	"duration_ms" integer,
	"ttft_ms" integer,
	"decode_tps" real,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"total_tokens" integer,
	"engine_meta" jsonb,
	"req_bytes" integer DEFAULT 0 NOT NULL,
	"res_bytes" integer DEFAULT 0 NOT NULL,
	"source_addr" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_buckets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"granularity" "bucket_granularity" NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"ttft_p50_ms" real,
	"ttft_p95_ms" real,
	"duration_p95_ms" real,
	"decode_tps" real,
	"decode_tps_weight" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "capture_proxy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD CONSTRAINT "llm_requests_setup_id_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."setups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_buckets" ADD CONSTRAINT "usage_buckets_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_requests_node_received_idx" ON "llm_requests" USING btree ("node_id","received_at");--> statement-breakpoint
CREATE INDEX "llm_requests_model_idx" ON "llm_requests" USING btree ("model","received_at");--> statement-breakpoint
CREATE INDEX "llm_requests_sig_idx" ON "llm_requests" USING btree ("error_sig","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_buckets_uq" ON "usage_buckets" USING btree ("node_id","model","granularity","bucket_start");--> statement-breakpoint
CREATE INDEX "usage_buckets_bucket_idx" ON "usage_buckets" USING btree ("granularity","bucket_start");