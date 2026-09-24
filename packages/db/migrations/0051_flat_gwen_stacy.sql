CREATE TABLE "knowledge_auto_index" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_auto_index" ADD CONSTRAINT "knowledge_auto_index_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_auto_index" ADD CONSTRAINT "knowledge_auto_index_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_auto_index_org_enabled_idx" ON "knowledge_auto_index" USING btree ("org_id","enabled");