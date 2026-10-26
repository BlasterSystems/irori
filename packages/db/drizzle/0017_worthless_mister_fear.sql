CREATE TABLE "node_inventory" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"report" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_inventory" ADD CONSTRAINT "node_inventory_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;