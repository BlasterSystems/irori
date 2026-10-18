CREATE TYPE "public"."setup_health" AS ENUM('starting', 'healthy', 'foreign', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."setup_run_status" AS ENUM('running', 'exited', 'stopped', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."setup_status" AS ENUM('stopped', 'starting', 'running', 'stopping', 'failed');--> statement-breakpoint
CREATE TABLE "setup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setup_id" uuid NOT NULL,
	"status" "setup_run_status" DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"pid" integer,
	"pgid" integer,
	"log_path" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "setup_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setup_id" uuid NOT NULL,
	"stages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "setups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"port" integer NOT NULL,
	"head_node_id" uuid NOT NULL,
	"nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"script_start" text NOT NULL,
	"script_stop" text NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "setup_status" DEFAULT 'stopped' NOT NULL,
	"health" "setup_health",
	"last_error" text,
	"startup_timeout_ms" integer DEFAULT 900000 NOT NULL,
	"last_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "setup_runs" ADD CONSTRAINT "setup_runs_setup_id_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."setups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_transfers" ADD CONSTRAINT "setup_transfers_setup_id_setups_id_fk" FOREIGN KEY ("setup_id") REFERENCES "public"."setups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setups" ADD CONSTRAINT "setups_head_node_id_nodes_id_fk" FOREIGN KEY ("head_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "setup_runs_setup_idx" ON "setup_runs" USING btree ("setup_id","started_at");--> statement-breakpoint
CREATE INDEX "setup_transfers_setup_idx" ON "setup_transfers" USING btree ("setup_id","created_at");--> statement-breakpoint
CREATE INDEX "setups_head_idx" ON "setups" USING btree ("head_node_id");