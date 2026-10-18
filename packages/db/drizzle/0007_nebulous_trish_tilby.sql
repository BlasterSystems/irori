CREATE TYPE "public"."bench_status" AS ENUM('running', 'completed', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."bench_type" AS ENUM('decode', 'prefill', 'quality', 'tooleval');--> statement-breakpoint
CREATE TABLE "bench_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "bench_type" NOT NULL,
	"node_id" uuid NOT NULL,
	"status" "bench_status" DEFAULT 'running' NOT NULL,
	"config" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"model" text,
	"port" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bench_runs" ADD CONSTRAINT "bench_runs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bench_runs_type_idx" ON "bench_runs" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "bench_runs_node_idx" ON "bench_runs" USING btree ("node_id","created_at");