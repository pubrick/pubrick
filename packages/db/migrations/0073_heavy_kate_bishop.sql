ALTER TABLE "claim_reviews" DROP CONSTRAINT "claim_reviews_content_item_id_content_items_id_fk";
--> statement-breakpoint
ALTER TABLE "claim_reviews" ALTER COLUMN "content_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD COLUMN "active_delivery_token" uuid;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD COLUMN "unrecorded_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_reviews" ADD CONSTRAINT "claim_reviews_unrecorded_calls_check" CHECK ("claim_reviews"."unrecorded_calls" >= 0);
