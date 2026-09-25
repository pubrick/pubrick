CREATE TABLE "claim_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"content_item_id" uuid NOT NULL,
	"body_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "claim_reviews_status_check" CHECK ("claim_reviews"."status" in ('queued', 'running', 'ready', 'failed')),
	CONSTRAINT "claim_reviews_body_hash_check" CHECK (length("claim_reviews"."body_hash") = 64),
	CONSTRAINT "claim_reviews_error_code_check" CHECK ("claim_reviews"."error_code" IS NULL OR "claim_reviews"."error_code" IN ('no_ai_key', 'no_search_key', 'source_changed', 'provider_unavailable', 'invalid_response', 'internal_error')),
	CONSTRAINT "claim_reviews_result_invariant" CHECK ((("claim_reviews"."status" = 'queued' OR "claim_reviews"."status" = 'running') AND "claim_reviews"."completed_at" IS NULL AND "claim_reviews"."error_code" IS NULL) OR ("claim_reviews"."status" = 'ready' AND "claim_reviews"."completed_at" IS NOT NULL AND "claim_reviews"."error_code" IS NULL) OR ("claim_reviews"."status" = 'failed' AND "claim_reviews"."completed_at" IS NOT NULL AND "claim_reviews"."error_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_reviews_org_item_created_idx" ON "claim_reviews" USING btree ("org_id","content_item_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "claim_reviews_one_active_body_idx" ON "claim_reviews" USING btree ("org_id","content_item_id","body_hash") WHERE "claim_reviews"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "search_requests" ADD CONSTRAINT "search_requests_claim_review_id_claim_reviews_id_fk" FOREIGN KEY ("claim_review_id") REFERENCES "public"."claim_reviews"("id") ON DELETE set null ON UPDATE no action;
