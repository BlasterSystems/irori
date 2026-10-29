ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "progress" jsonb;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamp with time zone;
