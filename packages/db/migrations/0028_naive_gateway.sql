CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"news_item_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"source_url" text,
	"status" text DEFAULT 'idea' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_status_check" CHECK ("topics"."status" in ('idea', 'approved', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "editor_signal" text;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_news_item_id_news_items_id_fk" FOREIGN KEY ("news_item_id") REFERENCES "public"."news_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topics_org_brand_created_idx" ON "topics" USING btree ("org_id","brand_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_org_brand_news_item_idx" ON "topics" USING btree ("org_id","brand_id","news_item_id");--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_editor_signal_check" CHECK ("news_items"."editor_signal" in ('relevant', 'irrelevant'));