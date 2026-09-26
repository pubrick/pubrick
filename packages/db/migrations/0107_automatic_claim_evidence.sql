ALTER TABLE "claim_reviews" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "automatic_claim_evidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_trigger_check" CHECK ("claim_reviews"."trigger" in ('manual', 'automatic'));--> statement-breakpoint
ALTER TABLE "claim_reviews" DROP CONSTRAINT "claim_reviews_error_code_check";--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_error_code_check" CHECK ("claim_reviews"."error_code" IS NULL OR "claim_reviews"."error_code" IN ('no_ai_key', 'no_search_key', 'automatic_disabled', 'source_changed', 'provider_unavailable', 'invalid_response', 'internal_error'));
