ALTER TABLE "nodes" ADD COLUMN "cpu_clock_cap_mhz" integer;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "cpu_clock_cap_persistent" boolean DEFAULT false NOT NULL;