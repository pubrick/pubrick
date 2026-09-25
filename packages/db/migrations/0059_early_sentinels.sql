ALTER TABLE "content_items" DROP CONSTRAINT "content_items_status_check";--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "archived_from_status" text;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_archived_from_status_check" CHECK ("content_items"."archived_from_status" in ('draft', 'approved', 'partially_published', 'rejected', 'published', 'failed', 'archived'));--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_archive_pair_check" CHECK (("content_items"."status" = 'archived') = ("content_items"."archived_from_status" IS NOT NULL)
        AND ("content_items"."archived_from_status" IS NULL OR "content_items"."archived_from_status" <> 'archived'));--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_status_check" CHECK ("content_items"."status" in ('draft', 'approved', 'partially_published', 'rejected', 'published', 'failed', 'archived'));