-- runMigrations builds the partial archive index concurrently after this
-- transaction, so existing publication writes are not blocked by an index scan.
ALTER TABLE "publications" ADD COLUMN "brand_id" uuid;
