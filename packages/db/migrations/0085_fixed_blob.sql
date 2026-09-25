ALTER TABLE "content_image_slots" ADD COLUMN "alignment" text DEFAULT 'center' NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_entry_images" ADD COLUMN "alignment" text DEFAULT 'center' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_image_slots" ADD CONSTRAINT "content_image_slots_alignment_check" CHECK ("content_image_slots"."alignment" in ('left', 'center', 'right')) NOT VALID;--> statement-breakpoint
ALTER TABLE "feed_entry_images" ADD CONSTRAINT "feed_entry_images_alignment_check" CHECK ("feed_entry_images"."alignment" in ('left', 'center', 'right')) NOT VALID;
