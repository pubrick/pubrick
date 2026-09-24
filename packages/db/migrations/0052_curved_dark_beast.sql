ALTER TABLE "media_assets" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "video_media_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_video_media_id_media_assets_id_fk" FOREIGN KEY ("video_media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_one_media_check" CHECK ("content_items"."cover_media_id" IS NULL OR "content_items"."video_media_id" IS NULL);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_kind_check" CHECK ("media_assets"."kind" in ('image', 'video'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_shape_check" CHECK (("media_assets"."kind" = 'image' AND "media_assets"."mime_type" = 'image/jpeg' AND "media_assets"."width" IS NOT NULL AND "media_assets"."height" IS NOT NULL AND "media_assets"."width" > 0 AND "media_assets"."height" > 0) OR ("media_assets"."kind" = 'video' AND "media_assets"."mime_type" = 'video/mp4' AND "media_assets"."width" IS NULL AND "media_assets"."height" IS NULL));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_byte_size_check" CHECK ("media_assets"."byte_size" > 0);