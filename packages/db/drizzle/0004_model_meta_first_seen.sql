ALTER TABLE "model_meta" ADD COLUMN "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;
