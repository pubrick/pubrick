CREATE TABLE "news_comment_collection_configs" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_scanned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_comment_collection_configs_revision_check" CHECK ("news_comment_collection_configs"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "news_comment_collection_configs" ADD CONSTRAINT "news_comment_collection_configs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_comment_collection_configs" ADD CONSTRAINT "news_comment_collection_configs_brand_org_fk" FOREIGN KEY ("org_id","brand_id") REFERENCES "public"."brands"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "news_comment_collection_configs_due_idx" ON "news_comment_collection_configs" USING btree ("enabled","last_scanned_at");