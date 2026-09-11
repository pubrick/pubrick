-- 0018 — a post whose channels disagreed has a status of its own.
--
-- WHAT WAS WRONG. Two channels approved together, one publishes, the other
-- fails permanently: the worker's recompute promotes an item only when EVERY
-- delivery reached the SAME terminal state, so it wrote nothing, and
-- `content_items.status` kept `approve`'s own `approved` for ever — painted in
-- the blue of work in flight, filed under the queue's "Approved" heading, with
-- nothing left in the product that would ever recompute it. `partially_published`
-- is the third verdict (`nextItemStatus`, `@pubrick/shared`): every delivery
-- over, at least one live, at least one not.
--
-- THE CHECK IS REWRITTEN FIRST, and the backfill below could not run before it:
-- the constraint is built from `CONTENT_STATUSES` (`enumCheck`), so an UPDATE
-- writing the new value against the old set is `23514` and the whole migration
-- rolls back. Drop-then-add rather than `ALTER ... ADD ... NOT VALID`: the set
-- only widens here, so every existing row already satisfies the new constraint
-- and the validating scan has nothing to find.
--
-- AND THIS MIGRATION REWRITES ROWS ON PURPOSE — the one place in this folder
-- that does, and the exception `expectNoRowRewritten` (`migrate.test.ts`) names
-- as "precisely the class this test exists to catch". It is not a convenience:
-- every stranded fan-out in an existing database is an item nothing can move,
-- because the only writer of that promotion is a delivery and every delivery
-- this item had is already over. Leaving them would ship a status that only
-- ever describes posts sent after the deploy, and go on lying about the ones
-- that are already broken. Do not "fix" this file by deleting the UPDATE.
--
-- `exists`, NOT `bool_and`/`bool_or`, and the reason is legibility rather than
-- the trap the design named. This is `nextItemStatus`' third arm transcribed,
-- and the fold's empty guard IS load-bearing in TypeScript — `every` over an
-- empty array is `true` for all three arms, so without it an item whose
-- channels were all deleted would be promoted about posts nobody sent. SQL
-- fails the other way: `bool_and` over an empty set is `NULL`, `NULL` is not
-- `true`, and a `WHERE` that cannot decide does not update. Measured, not
-- assumed: writing this predicate with `bool_and` is an EQUIVALENT mutant here
-- (`scripts/mutation-check.mjs @pubrick/db`, SURVIVED 3/3), and so is dropping
-- the first clause, because the two `exists` clauses below each already need a
-- row. The first clause stays anyway — it is the fold's own guard in the fold's
-- own order, and a reader comparing the two should not have to reason about
-- three-valued logic to see that the empty fan-out is refused. What is NOT
-- redundant is the `not exists` terminality clause: dropping it promotes an
-- item with a `queued` half, and `migrate.test.ts` kills that.
-- That test runs this predicate and the fold over the same 38 fan-outs — every
-- multiset over the six adaptation statuses up to two deliveries, every
-- multiset of size three over {published, failed, queued}, and the empty set —
-- and asserts they agree on each.
--
-- Mid-delivery rows are excluded by construction: an item with a `queued` half
-- fails the `not exists` clause, and the worker's own recompute answers for it
-- correctly when that delivery lands.
--
-- ROLLING DEPLOY. Unlike 0017 this one is visible the moment it commits — the
-- api starts answering `partially_published` at once — and on a web bundle that
-- predates it such a post is not merely unlabelled: the queue's sections are
-- derived from that bundle's own status list, so a post in none of them is
-- drawn in no section at all and disappears from the queue until web is
-- upgraded. `docs/self-hosting.md` §Upgrade says to deploy web BEFORE this
-- migration for anyone rolling services one at a time. Nothing the WORKER reads
-- changes shape, so "worker first is always safe" stays true.
ALTER TABLE "content_items" DROP CONSTRAINT "content_items_status_check";--> statement-breakpoint
ALTER TABLE "content_items" ADD CONSTRAINT "content_items_status_check" CHECK ("content_items"."status" in ('draft', 'approved', 'partially_published', 'rejected', 'published', 'failed'));--> statement-breakpoint
UPDATE "content_items" ci SET status = 'partially_published'
 WHERE ci.status = 'approved'
   AND exists (select 1 from adaptations a where a.content_item_id = ci.id)
   AND not exists (select 1 from adaptations a
                    where a.content_item_id = ci.id and a.status not in ('published', 'failed'))
   AND exists (select 1 from adaptations a
                where a.content_item_id = ci.id and a.status = 'published')
   AND exists (select 1 from adaptations a
                where a.content_item_id = ci.id and a.status <> 'published');
