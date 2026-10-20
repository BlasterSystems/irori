CREATE TYPE "public"."download_queue_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'canceled', 'removed');--> statement-breakpoint
CREATE TABLE "download_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"status" "download_queue_status" DEFAULT 'pending' NOT NULL,
	"job_id" uuid,
	"jobs" integer DEFAULT 4 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_queue" ADD CONSTRAINT "download_queue_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "download_queue_status_idx" ON "download_queue" USING btree ("status","created_at");