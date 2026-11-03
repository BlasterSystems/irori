CREATE TABLE "model_prices" (
	"pattern" text PRIMARY KEY NOT NULL,
	"input" real NOT NULL,
	"cached" real NOT NULL,
	"output" real NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "model_prices_pattern_idx" ON "model_prices" USING btree ("pattern");