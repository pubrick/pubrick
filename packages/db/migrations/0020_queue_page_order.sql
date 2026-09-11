-- REFRESH `when` IN `meta/_journal.json` ON EVERY REBASE THAT CARRIES THIS FILE.
-- drizzle applies an entry only when its `when` is strictly greater than the
-- largest `created_at` already in `drizzle.__drizzle_migrations`; a migration
-- that lands after one with a newer `when` is skipped in silence, for ever.
-- The tag was renumbered 0017 -> 0020 by hand to dodge a collision, so tag
-- order here is cosmetic: `when` is the only thing the migrator reads, and at
-- landing time it must be the newest in the journal. Ratcheted by
-- "keeps the journal's `when` strictly increasing, in tag order" (migrate.test.ts).
CREATE INDEX "content_items_org_id_created_at_id_idx" ON "content_items" USING btree ("org_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
