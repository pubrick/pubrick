ALTER TABLE "brands" ADD COLUMN "automatic_claim_evidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_trigger_check" CHECK ("claim_reviews"."trigger" in ('manual', 'automatic'));
