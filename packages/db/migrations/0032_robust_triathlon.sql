CREATE TABLE "news_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"telegram_message_id" integer NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "comments_status" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "comments_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "comments_error_code" text;--> statement-breakpoint
ALTER TABLE "news_comments" ADD CONSTRAINT "news_comments_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_comments" ADD CONSTRAINT "news_comments_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_comments" ADD CONSTRAINT "news_comments_item_id_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."news_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_comments_item_message_idx" ON "news_comments" USING btree ("item_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "news_comments_org_brand_item_idx" ON "news_comments" USING btree ("org_id","brand_id","item_id");--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_comments_status_check" CHECK ("news_items"."comments_status" in ('pending', 'available', 'unavailable', 'private', 'error'));