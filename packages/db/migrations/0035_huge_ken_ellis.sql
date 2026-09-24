CREATE TABLE "news_comment_analyses" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"sample_checked_at" timestamp with time zone NOT NULL,
	"result" jsonb NOT NULL,
	"sample_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "news_comment_analyses" ADD CONSTRAINT "news_comment_analyses_item_id_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."news_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_comment_analyses" ADD CONSTRAINT "news_comment_analyses_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_comment_analyses" ADD CONSTRAINT "news_comment_analyses_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "news_comment_analyses_org_brand_idx" ON "news_comment_analyses" USING btree ("org_id","brand_id");