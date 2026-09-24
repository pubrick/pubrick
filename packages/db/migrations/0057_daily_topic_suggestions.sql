ALTER TABLE "autopilot_configs" ADD COLUMN "auto_suggest_topics" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "topic_suggestion_requests" ADD COLUMN "origin" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "topic_suggestion_requests" ADD COLUMN "local_date" text;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_suggestion_requests_org_brand_local_date_idx" ON "topic_suggestion_requests" USING btree ("org_id","brand_id","local_date") WHERE "topic_suggestion_requests"."origin" = 'automatic' and "topic_suggestion_requests"."local_date" is not null;--> statement-breakpoint
-- Existing requests all receive the default 'manual' origin. Enforce new writes without scanning the full table at startup.
ALTER TABLE "topic_suggestion_requests" ADD CONSTRAINT "topic_suggestion_requests_origin_check" CHECK ("topic_suggestion_requests"."origin" in ('manual', 'automatic')) NOT VALID;
