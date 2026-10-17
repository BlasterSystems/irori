CREATE TYPE "public"."bucket_granularity" AS ENUM('minute', 'hour', 'day');--> statement-breakpoint
CREATE TABLE "snapshot_buckets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"granularity" "bucket_granularity" NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"cpu_usage_pct" real,
	"cpu_temp_c" real,
	"cpu_temp_min_c" real,
	"cpu_temp_max_c" real,
	"package_power_w" real,
	"mem_used_bytes" double precision,
	"mem_total_bytes" double precision,
	"gpu_usage_pct" real,
	"gpu_temp_c" real,
	"gpu_temp_min_c" real,
	"gpu_temp_max_c" real,
	"gpu_power_w" real,
	"gpu_mem_used_bytes" double precision,
	"net_rx_bps" double precision,
	"net_tx_bps" double precision
);
--> statement-breakpoint
ALTER TABLE "snapshot_buckets" ADD CONSTRAINT "snapshot_buckets_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_buckets_uq" ON "snapshot_buckets" USING btree ("node_id","granularity","bucket_start");