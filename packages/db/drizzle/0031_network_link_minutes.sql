-- IRI-168 (ADR-0021): per-link minute history, 7-day retention. Additive; rollback = DROP TABLE network_link_minutes.
CREATE TABLE IF NOT EXISTS "network_link_minutes" (
	"link_id" text NOT NULL,
	"a_node_id" uuid NOT NULL,
	"b_node_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"tx_bps_avg" double precision,
	"rx_bps_avg" double precision,
	"tx_bps_max" double precision,
	"rx_bps_max" double precision,
	"rtt_ms_avg" real,
	"loss_pct_avg" real,
	"samples" integer NOT NULL,
	CONSTRAINT "network_link_minutes_link_id_bucket_start_pk" PRIMARY KEY("link_id","bucket_start"),
	CONSTRAINT "network_link_minutes_a_node_id_nodes_id_fk" FOREIGN KEY ("a_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "network_link_minutes_b_node_id_nodes_id_fk" FOREIGN KEY ("b_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_link_minutes_bucket_idx" ON "network_link_minutes" USING btree ("bucket_start");
