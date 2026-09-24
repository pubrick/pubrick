CREATE TABLE "brand_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"public_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_feeds_public_token_unique" UNIQUE("public_token"),
	CONSTRAINT "brand_feeds_brand_id_key" UNIQUE("brand_id")
);
--> statement-breakpoint
CREATE TABLE "feed_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"feed_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_entries_feed_item_key" UNIQUE("feed_id","content_item_id")
);
--> statement-breakpoint
ALTER TABLE "brand_feeds" ADD CONSTRAINT "brand_feeds_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_feeds" ADD CONSTRAINT "brand_feeds_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_feed_id_brand_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."brand_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_feeds_org_id_idx" ON "brand_feeds" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "feed_entries_org_id_idx" ON "feed_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "feed_entries_feed_id_published_at_idx" ON "feed_entries" USING btree ("feed_id","published_at" DESC NULLS LAST);