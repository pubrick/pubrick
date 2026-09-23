ALTER TABLE "news_items" ADD COLUMN "relevance_status" text DEFAULT 'unscored' NOT NULL;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "relevance_score" double precision;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "relevance_reason" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "relevance_urgency" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "relevance_error_code" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "relevance_scored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "relevance_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "news_items_org_brand_relevance_idx" ON "news_items" USING btree ("org_id","brand_id","relevance_status","relevance_score");--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_relevance_status_check" CHECK ("news_items"."relevance_status" in ('unscored', 'scored', 'failed'));--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_relevance_urgency_check" CHECK ("news_items"."relevance_urgency" in ('breaking', 'timely', 'evergreen'));--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_relevance_error_code_check" CHECK ("news_items"."relevance_error_code" in ('no_api_key', 'unreadable_key', 'model_failed'));--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_relevance_score_check" CHECK ("news_items"."relevance_score" IS NULL OR ("news_items"."relevance_score" >= 0 AND "news_items"."relevance_score" <= 1));--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_relevance_consistency_check" CHECK (("news_items"."relevance_status" = 'scored') = ("news_items"."relevance_score" IS NOT NULL AND "news_items"."relevance_reason" IS NOT NULL AND "news_items"."relevance_urgency" IS NOT NULL AND "news_items"."relevance_scored_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_relevance_attempts_check" CHECK ("news_items"."relevance_attempts" >= 0);