CREATE TYPE "public"."node_kind" AS ENUM('spark', 'gpu-host', 'nas');--> statement-breakpoint
CREATE TYPE "public"."node_role" AS ENUM('head', 'worker', 'standalone');--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "node_kind" NOT NULL,
	"role" "node_role" NOT NULL,
	"host" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"agent_token_hash" text NOT NULL,
	"agent_token_enc" text NOT NULL,
	"agent_version" text,
	"last_seen_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"value_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_name_uq" ON "nodes" USING btree ("name");--> statement-breakpoint
CREATE INDEX "nodes_agent_token_hash_idx" ON "nodes" USING btree ("agent_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_name_uq" ON "secrets" USING btree ("name");--> statement-breakpoint
CREATE INDEX "snapshots_node_time_idx" ON "snapshots" USING btree ("node_id","server_time");