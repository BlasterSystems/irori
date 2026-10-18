CREATE TABLE "node_models" (
	"node_id" uuid NOT NULL,
	"model" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_models_node_id_model_pk" PRIMARY KEY ("node_id", "model")
);
--> statement-breakpoint
ALTER TABLE "node_models" ADD CONSTRAINT "node_models_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
