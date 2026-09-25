ALTER TABLE "content_items" ADD COLUMN "quality_score" double precision;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_quality_score_check" CHECK ("content_items"."quality_score" >= 0 AND "content_items"."quality_score" <= 1);
