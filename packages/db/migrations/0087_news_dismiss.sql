ALTER TABLE "news_items" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "dismissed_previous_signal" text;--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_dismissed_previous_signal_check" CHECK ("news_items"."dismissed_previous_signal" in ('relevant', 'irrelevant'));--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_dismissed_previous_signal_state_check" CHECK ("news_items"."dismissed_at" IS NOT NULL OR "news_items"."dismissed_previous_signal" IS NULL);