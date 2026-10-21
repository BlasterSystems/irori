CREATE TABLE "llm_request_tools" (
	"request_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"model" text,
	"calls" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"args_chars" integer DEFAULT 0 NOT NULL,
	"result_chars" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "llm_request_tools_request_id_tool_pk" PRIMARY KEY("request_id","tool")
);
--> statement-breakpoint
ALTER TABLE "llm_request_tools" ADD CONSTRAINT "llm_request_tools_request_id_llm_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."llm_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_request_tools_tool_idx" ON "llm_request_tools" USING btree ("tool","model");