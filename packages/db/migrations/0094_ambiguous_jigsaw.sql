ALTER TABLE "content_items" ADD COLUMN "rich_body" jsonb;--> statement-breakpoint
ALTER TABLE "content_items" ADD COLUMN "body_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_entries" ADD COLUMN "rich_body" jsonb;--> statement-breakpoint
ALTER TABLE "content_versions" ADD COLUMN "rich_body" jsonb;--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_body_revision_check" CHECK ("content_items"."body_revision" >= 0);
--> statement-breakpoint
-- The trigger covers every body writer, including the worker and older API clients.
-- A text-only write invalidates the rich projection in the same transaction.
CREATE FUNCTION content_items_rich_body_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body AND NEW.rich_body IS NOT DISTINCT FROM OLD.rich_body THEN
    NEW.rich_body := NULL;
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.rich_body IS DISTINCT FROM OLD.rich_body THEN
    NEW.body_revision := OLD.body_revision + 1;
  ELSE
    NEW.body_revision := OLD.body_revision;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER content_items_rich_body_revision
BEFORE UPDATE ON content_items
FOR EACH ROW EXECUTE FUNCTION content_items_rich_body_revision();
