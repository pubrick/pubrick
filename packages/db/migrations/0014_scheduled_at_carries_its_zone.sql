-- THE PUBLISHING PATH'S TIMESTAMPS BECOME INSTANTS.
--
-- Every column below held an instant in a `timestamp` WITHOUT time zone, which
-- is a wall clock plus an unwritten assumption about whose. Two writers filled
-- them with two different clocks: the api and the worker send a JavaScript
-- `Date` (a UTC wall clock, whatever the database's zone), while `now()` — the
-- DEFAULT on most of these, and the worker's explicit stamp on `updated_at` —
-- writes the SESSION's wall clock. Those are the same number only while the
-- database runs in UTC, which the project's compose file pins and a
-- self-hoster's Postgres need not.
--
-- WHAT THIS DOES TO A ROW THAT ALREADY EXISTS: it reads its stored wall clock
-- AS UTC — `USING col AT TIME ZONE 'UTC'` — rather than letting the implicit
-- cast read it in whatever zone the migration's own session happens to be in.
--
-- That is the right reading for three reasons that point the same way:
--
--  1. It is unconditionally correct for every value written from JavaScript.
--     drizzle serialises a `Date` with `toISOString()`, so `scheduled_at` and
--     `first_opened_at` are UTC wall clocks in every deployment that has ever
--     run, on any machine, in any zone.
--  2. It is correct for every `now()`-written value on a UTC database — the one
--     configuration in which this product has been correct, and the assumption
--     the whole defect rests on.
--  3. On a NON-UTC database it is still the only reading that does not move
--     anything. Those `now()` values were already being read back as UTC by
--     every drizzle query in the product, so UTC is the interpretation the api
--     has been serving and the screens have been showing all along. Taking the
--     session's zone instead would shift a live scheduled post by the offset at
--     migration time — turning a latent disagreement between two columns into a
--     real change to a post somebody is waiting on.
--
-- Nothing here touches the queue. pg-boss holds a scheduled job's firing time
-- on its own `timestamptz` `start_after`, which was always an instant, so no
-- post changes when it goes out. Reading these columns as UTC is what makes the
-- column agree with the job again instead of drifting away from it.
--
-- Each `DEFAULT now()` is restated after its column changes type — Postgres
-- carries it across on its own, and restating it is what makes the column's
-- default read identically to the snapshot drizzle-kit records for this
-- migration. It now assigns an instant instead of casting one down to a wall
-- clock.
--
-- Each `ALTER ... SET DATA TYPE` rewrites its table under an ACCESS EXCLUSIVE
-- lock, and drizzle runs every pending migration in one transaction, so the six
-- tables are locked together for the length of the rewrite. That is a real
-- pause at api boot rather than a free change — it is bounded by the size of a
-- single install's content tables, which is the trade being made, and it is the
-- reason the columns are converted once rather than a table at a time.
--
-- `pipeline_runs`, `usage_ledger`, `ai_credentials` and better-auth's tables are
-- deliberately not here; `packages/db/src/timestamp-zone.test.ts` holds the
-- reason for each and fails if a new naive column joins them unannounced.
ALTER TABLE "brands" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "brands" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "brands" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "brands" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "content_items" ALTER COLUMN "first_opened_at" SET DATA TYPE timestamp with time zone USING "first_opened_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "content_items" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "content_items" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "content_items" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "content_items" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "adaptations" ALTER COLUMN "scheduled_at" SET DATA TYPE timestamp with time zone USING "scheduled_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "adaptations" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "adaptations" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "adaptations" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone USING "updated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "adaptations" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "publications" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "publications" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "content_versions" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "content_versions" ALTER COLUMN "created_at" SET DEFAULT now();
