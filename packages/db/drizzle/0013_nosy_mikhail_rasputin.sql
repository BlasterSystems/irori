CREATE TYPE "public"."client_agent_type" AS ENUM('main', 'subagent');--> statement-breakpoint
CREATE TABLE "client_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"project" text,
	"agent_type" "client_agent_type",
	"key_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_identities_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "client_key_hash" text;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "client_project" text;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "client_agent_type" text;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "retry_attempt" integer;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "retry_kind" text;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "retry_status" text;--> statement-breakpoint
ALTER TABLE "llm_requests" ADD COLUMN "retry_superseded_by" text;--> statement-breakpoint
CREATE INDEX "client_identities_key_idx" ON "client_identities" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "llm_requests_client_idx" ON "llm_requests" USING btree ("client_agent_type","received_at");--> statement-breakpoint
CREATE INDEX "llm_requests_project_idx" ON "llm_requests" USING btree ("client_project","received_at");--> statement-breakpoint
CREATE INDEX "llm_requests_key_idx" ON "llm_requests" USING btree ("client_key_hash","received_at");