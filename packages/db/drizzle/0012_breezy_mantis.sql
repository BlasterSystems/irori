CREATE TABLE "llm_parts" (
	"hash" text PRIMARY KEY NOT NULL,
	"bytes" integer NOT NULL,
	"gz" "bytea" NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"refcount" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_request_parts" (
	"request_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"hash" text NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"bytes" integer NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "llm_request_parts_request_id_ordinal_pk" PRIMARY KEY("request_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "setups" ADD COLUMN "body_retention" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_request_parts" ADD CONSTRAINT "llm_request_parts_request_id_llm_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."llm_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_parts_created_idx" ON "llm_parts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_request_parts_hash_idx" ON "llm_request_parts" USING btree ("hash");