CREATE TABLE "cleanup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb,
	"error" text,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "energy_monthly" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"month_start" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"gpu_wh" double precision,
	"cpu_wh" double precision,
	"base_wh" double precision,
	"total_wh" double precision,
	"gpu_coverage" real,
	"cpu_coverage" real
);
--> statement-breakpoint
CREATE TABLE "token_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"port" integer NOT NULL,
	"model" text NOT NULL,
	"granularity" "bucket_granularity" NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"generated_tokens" bigint DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"generated_seen" boolean DEFAULT false NOT NULL,
	"prompt_seen" boolean DEFAULT false NOT NULL,
	"cached_seen" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snapshot_buckets" ADD COLUMN "gpu_throttled" boolean;--> statement-breakpoint
ALTER TABLE "cleanup_runs" ADD CONSTRAINT "cleanup_runs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_runs" ADD CONSTRAINT "cleanup_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "energy_monthly" ADD CONSTRAINT "energy_monthly_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_ledger" ADD CONSTRAINT "token_ledger_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cleanup_runs_node_idx" ON "cleanup_runs" USING btree ("node_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "energy_monthly_uq" ON "energy_monthly" USING btree ("node_id","month_start");--> statement-breakpoint
CREATE UNIQUE INDEX "token_ledger_uq" ON "token_ledger" USING btree ("node_id","port","model","granularity","bucket_start");--> statement-breakpoint
CREATE INDEX "token_ledger_bucket_idx" ON "token_ledger" USING btree ("granularity","bucket_start");