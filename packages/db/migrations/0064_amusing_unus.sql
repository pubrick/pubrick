-- Existing feed entries inherit their brand from the feed that owns them.
ALTER TABLE "content_items" ADD COLUMN "images_revision" integer;--> statement-breakpoint
ALTER TABLE "content_items" ALTER COLUMN "images_revision" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD COLUMN "brand_id" uuid;--> statement-breakpoint
UPDATE "feed_entries" AS e SET "brand_id" = f."brand_id" FROM "brand_feeds" AS f WHERE e."feed_id" = f."id";--> statement-breakpoint
ALTER TABLE "feed_entries" ALTER COLUMN "brand_id" SET NOT NULL;--> statement-breakpoint
-- Composite parent keys must exist before adding tenant/brand-safe foreign keys.
CREATE UNIQUE INDEX "content_items_org_brand_id_idx" ON "content_items" USING btree ("org_id","brand_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_feeds_org_brand_id_idx" ON "brand_feeds" USING btree ("org_id","brand_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_entries_org_brand_id_idx" ON "feed_entries" USING btree ("org_id","brand_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_org_brand_id_idx" ON "media_assets" USING btree ("org_id","brand_id","id");--> statement-breakpoint
CREATE TABLE "content_image_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"content_item_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"after_paragraph" integer NOT NULL,
	"alt" text NOT NULL,
	"caption" text,
	CONSTRAINT "content_image_slots_item_paragraph_key" UNIQUE("content_item_id","after_paragraph"),
	CONSTRAINT "content_image_slots_paragraph_check" CHECK ("content_image_slots"."after_paragraph" >= 0),
	CONSTRAINT "content_image_slots_alt_check" CHECK (length(btrim("content_image_slots"."alt")) BETWEEN 1 AND 300),
	CONSTRAINT "content_image_slots_caption_check" CHECK ("content_image_slots"."caption" IS NULL OR length("content_image_slots"."caption") <= 500)
);
--> statement-breakpoint
CREATE TABLE "feed_entry_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" uuid NOT NULL,
	"feed_entry_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"after_paragraph" integer NOT NULL,
	"alt" text NOT NULL,
	"caption" text,
	"position" integer NOT NULL,
	CONSTRAINT "feed_entry_images_entry_position_key" UNIQUE("feed_entry_id","position"),
	CONSTRAINT "feed_entry_images_entry_paragraph_key" UNIQUE("feed_entry_id","after_paragraph"),
	CONSTRAINT "feed_entry_images_paragraph_check" CHECK ("feed_entry_images"."after_paragraph" >= 0),
	CONSTRAINT "feed_entry_images_position_check" CHECK ("feed_entry_images"."position" >= 0),
	CONSTRAINT "feed_entry_images_alt_check" CHECK (length(btrim("feed_entry_images"."alt")) BETWEEN 1 AND 300),
	CONSTRAINT "feed_entry_images_caption_check" CHECK ("feed_entry_images"."caption" IS NULL OR length("feed_entry_images"."caption") <= 500)
);
--> statement-breakpoint
ALTER TABLE "content_image_slots" ADD CONSTRAINT "content_image_slots_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_image_slots" ADD CONSTRAINT "content_image_slots_item_brand_fk" FOREIGN KEY ("org_id","brand_id","content_item_id") REFERENCES "public"."content_items"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_image_slots" ADD CONSTRAINT "content_image_slots_media_brand_fk" FOREIGN KEY ("org_id","brand_id","media_id") REFERENCES "public"."media_assets"("org_id","brand_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entry_images" ADD CONSTRAINT "feed_entry_images_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entry_images" ADD CONSTRAINT "feed_entry_images_entry_brand_fk" FOREIGN KEY ("org_id","brand_id","feed_entry_id") REFERENCES "public"."feed_entries"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_entry_images" ADD CONSTRAINT "feed_entry_images_media_brand_fk" FOREIGN KEY ("org_id","brand_id","media_id") REFERENCES "public"."media_assets"("org_id","brand_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_image_slots_media_id_idx" ON "content_image_slots" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "feed_entry_images_media_id_idx" ON "feed_entry_images" USING btree ("media_id");--> statement-breakpoint
ALTER TABLE "feed_entries" ADD CONSTRAINT "feed_entries_feed_brand_fk" FOREIGN KEY ("org_id","brand_id","feed_id") REFERENCES "public"."brand_feeds"("org_id","brand_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A body edit may not strand an attached image beyond the last paragraph.
CREATE FUNCTION "content_image_slots_guard_body"() RETURNS trigger AS $$
DECLARE
  paragraph_count integer;
BEGIN
  IF NEW."body" IS NOT DISTINCT FROM OLD."body" THEN RETURN NEW; END IF;
  SELECT COUNT(*) INTO paragraph_count
  FROM regexp_split_to_table(NEW."body", E'\n[[:space:]]*\n') AS paragraph
  WHERE paragraph ~ '[^[:space:]]';
  IF EXISTS (
    SELECT 1 FROM "content_image_slots" AS s
    WHERE s."content_item_id" = NEW."id" AND s."after_paragraph" >= paragraph_count
  ) THEN
    RAISE EXCEPTION 'Inline image position exceeds the edited body'
      USING ERRCODE = '23514', CONSTRAINT = 'content_image_slots_body_position_check';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "content_image_slots_body_update" BEFORE UPDATE OF "body" ON "content_items"
FOR EACH ROW EXECUTE FUNCTION "content_image_slots_guard_body"();
