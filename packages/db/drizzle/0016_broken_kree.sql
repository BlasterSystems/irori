ALTER TABLE "download_queue" ADD COLUMN "force" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "download_queue" ADD COLUMN "bytes_done" bigint;--> statement-breakpoint
ALTER TABLE "download_queue" ADD COLUMN "bytes_total" bigint;--> statement-breakpoint
ALTER TABLE "download_queue" ADD COLUMN "speed_bps" bigint;