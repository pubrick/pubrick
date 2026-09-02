-- 0009 — the constraints the code already assumes.
--
-- Three things the application has believed since it was written and the
-- database has never enforced:
--
--   1. ONE UNDELIVERED ADAPTATION PER (item, channel). An adaptation IS a
--      delivery — `approve` enqueues one publish job per adaptation row — so a
--      second row naming the same channel is a second post to a channel whose
--      reviewer approved one. Demonstrated, not theorised: with the duplicate
--      written directly, approving the item enqueued two live publish jobs
--      under one channel's group. Partial on `status <> 'published'`, so a
--      published row stays as history and a later re-adaptation may add a
--      fresh live row beside it.
--   2. A VERSION ROW'S ADAPTATION BELONGS TO THE VERSION'S ITEM. A composite
--      foreign key, which needs the parent unique key added just before it.
--      MATCH SIMPLE leaves master-level rows (`adaptation_id IS NULL`) alone.
--   3. EVERY ENUM COLUMN PINNED TO ITS VALUE SET. `text(col, { enum: [...] })`
--      is a compile-time claim; the column is plain text in Postgres, and a row
--      outside the set is invisible to every set operation in the product.
--
-- The schema modules carry the full argument for each; this file carries the
-- two things only the migration can say.
--
-- STATEMENT ORDER. The unique key on `adaptations (id, content_item_id)` is
-- emitted BEFORE the foreign key that references it. drizzle-kit generates them
-- the other way round, and Postgres refuses a foreign key whose referenced
-- columns carry no unique constraint yet.
--
-- WHY THE PREFLIGHT BELOW. `ALTER TABLE ... ADD CONSTRAINT ... CHECK` over a
-- table holding a bad row fails with `check constraint "x" of relation "y" is
-- violated by some row` — which names neither the row nor the value, on a
-- database whose operator does not yet know what to look for. The preflight
-- runs the same scan first and raises a message naming the table, the column
-- and the offending values, so a self-hoster whose data predates these
-- constraints is told what to fix. It raises rather than repairs: this
-- migration must never guess what a value outside the enum was supposed to
-- mean. The other two constraints need no such help — `could not create unique
-- index` and the FK violation both name the offending key themselves.
--
-- WHY NOT `NOT VALID` + `VALIDATE CONSTRAINT`, the usual kindness on a large
-- table: drizzle runs every pending migration inside ONE transaction
-- (drizzle-orm/pg-core/dialect.js), so the ACCESS EXCLUSIVE lock `ADD
-- CONSTRAINT` takes is held until the whole migration commits either way. The
-- two-step would buy nothing here but two statements per constraint — and that
-- same single transaction is what makes the preflight total: it raises, the
-- transaction rolls back, and no half-constrained schema is left behind.
DO $$
DECLARE
  target record;
  offenders text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('channels', 'platform', ARRAY['telegram','vk','dzen','vc_ru','max','bluesky','mastodon','x']),
      ('content_items', 'status', ARRAY['draft','approved','rejected','published','failed']),
      ('content_items', 'origin', ARRAY['ai','human']),
      ('adaptations', 'status', ARRAY['pending','scheduled','queued','publishing','published','failed']),
      ('adaptations', 'origin', ARRAY['ai','human']),
      ('publications', 'status', ARRAY['in_flight','published','failed','unknown']),
      ('ai_credentials', 'provider', ARRAY['google','openrouter']),
      ('content_versions', 'origin', ARRAY['ai','human']),
      ('content_versions', 'scope', ARRAY['full','fragment']),
      ('pipeline_runs', 'status', ARRAY['queued','running','succeeded','failed','cancelled']),
      ('usage_ledger', 'provider', ARRAY['google','openrouter']),
      ('usage_ledger', 'cost_source', ARRAY['provider_reported','price_table','unknown']),
      ('usage_ledger', 'status', ARRAY['ok','errored']),
      ('usage_ledger', 'key_ownership', ARRAY['byok','platform'])
    ) AS t(table_name, column_name, allowed)
  LOOP
    EXECUTE format(
      'SELECT string_agg(DISTINCT quote_literal(v), '', '' ORDER BY quote_literal(v)) FROM (SELECT %I AS v FROM %I WHERE %I <> ALL ($1) LIMIT 50) s',
      target.column_name, target.table_name, target.column_name
    ) INTO offenders USING target.allowed;
    IF offenders IS NOT NULL THEN
      RAISE EXCEPTION
        'Cannot pin %.% to its value set: existing rows hold %',
        target.table_name, target.column_name, offenders
        USING HINT = format(
          'Decide what each value meant and UPDATE those rows to a member of (%s), then re-run the migration.',
          array_to_string(target.allowed, ', ')
        );
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_id_content_item_id_key" UNIQUE("id","content_item_id");--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_adaptation_belongs_to_item_fk" FOREIGN KEY ("adaptation_id","content_item_id") REFERENCES "public"."adaptations"("id","content_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "adaptations_one_live_per_item_channel" ON "adaptations" USING btree ("content_item_id","channel_id") WHERE "adaptations"."status" <> 'published';--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_platform_check" CHECK ("channels"."platform" in ('telegram', 'vk', 'dzen', 'vc_ru', 'max', 'bluesky', 'mastodon', 'x'));--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_status_check" CHECK ("adaptations"."status" in ('pending', 'scheduled', 'queued', 'publishing', 'published', 'failed'));--> statement-breakpoint
ALTER TABLE "adaptations" ADD CONSTRAINT "adaptations_origin_check" CHECK ("adaptations"."origin" in ('ai', 'human'));--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_status_check" CHECK ("content_items"."status" in ('draft', 'approved', 'rejected', 'published', 'failed'));--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_origin_check" CHECK ("content_items"."origin" in ('ai', 'human'));--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_status_check" CHECK ("publications"."status" in ('in_flight', 'published', 'failed', 'unknown'));--> statement-breakpoint
ALTER TABLE "ai_credentials" ADD CONSTRAINT "ai_credentials_provider_check" CHECK ("ai_credentials"."provider" in ('google', 'openrouter'));--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_origin_check" CHECK ("content_versions"."origin" in ('ai', 'human'));--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_scope_check" CHECK ("content_versions"."scope" in ('full', 'fragment'));--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_status_check" CHECK ("pipeline_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_provider_check" CHECK ("usage_ledger"."provider" in ('google', 'openrouter'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_cost_source_check" CHECK ("usage_ledger"."cost_source" in ('provider_reported', 'price_table', 'unknown'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_status_check" CHECK ("usage_ledger"."status" in ('ok', 'errored'));--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_key_ownership_check" CHECK ("usage_ledger"."key_ownership" in ('byok', 'platform'));
