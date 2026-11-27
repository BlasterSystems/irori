-- IRI-166 (ADR-0021): on-demand link tests. Additive; rollback = DROP TABLE network_tests.
CREATE TABLE IF NOT EXISTS "network_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" text NOT NULL,
	"a_node_id" uuid NOT NULL,
	"b_node_id" uuid NOT NULL,
	"a_iface" text NOT NULL,
	"b_iface" text NOT NULL,
	"a_ip" text NOT NULL,
	"b_ip" text NOT NULL,
	"tool" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stage" text,
	"override" boolean DEFAULT false NOT NULL,
	"forward_gbps" real,
	"reverse_gbps" real,
	"retransmits" integer,
	"rtt_p50_ms" real,
	"rtt_p99_ms" real,
	"loss_pct" real,
	"duration_s" integer NOT NULL,
	"streams" integer NOT NULL,
	"error" text,
	"result" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "network_tests_a_node_id_nodes_id_fk" FOREIGN KEY ("a_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "network_tests_b_node_id_nodes_id_fk" FOREIGN KEY ("b_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_tests_link_idx" ON "network_tests" USING btree ("link_id","started_at");
