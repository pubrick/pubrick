CREATE TABLE "organization_ai_text_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"provider" text,
	"model" text,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "organization_ai_text_settings_provider_check" CHECK ("organization_ai_text_settings"."provider" in ('google', 'openrouter', 'openai', 'anthropic', 'deepseek')),
	CONSTRAINT "organization_ai_text_settings_revision_check" CHECK ("organization_ai_text_settings"."revision" >= 0),
	CONSTRAINT "organization_ai_text_settings_model_check" CHECK ("organization_ai_text_settings"."model" IS NULL OR (length("organization_ai_text_settings"."model") BETWEEN 1 AND 200))
);
--> statement-breakpoint
ALTER TABLE "autopilot_manual_attempts" DROP CONSTRAINT "autopilot_manual_attempts_decision_check";--> statement-breakpoint
ALTER TABLE "autopilot_scan_events" DROP CONSTRAINT "autopilot_scan_events_decision_check";--> statement-breakpoint
ALTER TABLE "claim_reviews" DROP CONSTRAINT "claim_reviews_error_code_check";--> statement-breakpoint
ALTER TABLE "news_relevance_batch_items" DROP CONSTRAINT "news_relevance_batch_items_error_code_check";--> statement-breakpoint
ALTER TABLE "news_relevance_batches" DROP CONSTRAINT "news_relevance_batches_error_code_check";--> statement-breakpoint
ALTER TABLE "news_items" DROP CONSTRAINT "news_items_relevance_error_code_check";--> statement-breakpoint
ALTER TABLE "topic_suggestion_requests" DROP CONSTRAINT "topic_suggestion_requests_error_code_check";--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD COLUMN "text_selection" jsonb;--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "text_selection" jsonb;--> statement-breakpoint
ALTER TABLE "news_relevance_batches" ADD COLUMN "text_selection" jsonb;--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "text_selection" jsonb;--> statement-breakpoint
ALTER TABLE "topic_suggestion_requests" ADD COLUMN "text_selection" jsonb;--> statement-breakpoint
ALTER TABLE "organization_ai_text_settings" ADD CONSTRAINT "organization_ai_text_settings_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_manual_attempts" ADD CONSTRAINT "autopilot_manual_attempts_decision_check" CHECK ("autopilot_manual_attempts"."decision" in ('no_ai_key', 'disabled', 'before_start', 'quiet_hours', 'quota_full', 'budget_full', 'unpriced_spend', 'run_in_progress', 'org_busy', 'channels_missing', 'no_approved_topic', 'invalid_brief', 'dispatched', 'worker_failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "autopilot_scan_events" ADD CONSTRAINT "autopilot_scan_events_decision_check" CHECK ("autopilot_scan_events"."decision" in ('no_ai_key', 'disabled', 'before_start', 'quiet_hours', 'quota_full', 'budget_full', 'unpriced_spend', 'run_in_progress', 'org_busy', 'channels_missing', 'no_approved_topic', 'invalid_brief', 'dispatched', 'worker_failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_error_code_check" CHECK ("claim_reviews"."error_code" IS NULL OR "claim_reviews"."error_code" IN ('configuration_changed', 'no_ai_key', 'no_search_key', 'automatic_disabled', 'source_changed', 'provider_unavailable', 'invalid_response', 'internal_error')) NOT VALID;--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_revision_check" CHECK ("ai_credentials"."revision" > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "news_relevance_batch_items" ADD CONSTRAINT "news_relevance_batch_items_error_code_check" CHECK ("news_relevance_batch_items"."error_code" in ('no_api_key', 'configuration_changed', 'unreadable_key', 'invalid_key', 'model_not_found', 'provider_refused', 'model_failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "news_relevance_batches" ADD CONSTRAINT "news_relevance_batches_error_code_check" CHECK ("news_relevance_batches"."error_code" in ('no_api_key', 'configuration_changed', 'unreadable_key', 'invalid_key', 'model_not_found', 'provider_refused', 'model_failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "news_items" ADD CONSTRAINT "news_items_relevance_error_code_check" CHECK ("news_items"."relevance_error_code" in ('no_api_key', 'configuration_changed', 'unreadable_key', 'model_failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "topic_suggestion_requests" ADD CONSTRAINT "topic_suggestion_requests_error_code_check" CHECK ("topic_suggestion_requests"."error_code" in ('no_api_key', 'configuration_changed', 'unreadable_key', 'model_failed')) NOT VALID;
--> statement-breakpoint
-- Preserve legacy selection deterministically without decrypting credentials.
INSERT INTO "organization_ai_text_settings" ("org_id", "provider", "model", "revision")
SELECT DISTINCT ON ("org_id") "org_id", "provider", "default_model", 1
FROM "ai_credentials"
ORDER BY "org_id", "created_at", "provider"
ON CONFLICT ("org_id") DO NOTHING;
