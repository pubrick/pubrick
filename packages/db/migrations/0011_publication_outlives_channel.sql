-- 0011 — a published post outlives the channel it went to.
--
-- THE LOSS THIS CLOSES. `publications` is the durable record that a platform
-- accepted a message: its external id and its link are what the product's
-- "published, here it is" claim rests on. Both of its foreign keys were
-- `ON DELETE CASCADE`, so deleting a channel deleted every receipt of every
-- post ever made through it — and it did so twice over, because
-- `adaptations.channel_id` cascades too and `publications.adaptation_id`
-- cascaded off THAT. Measured before the change, on a channel with one
-- published post: 1 publication row before the delete, 0 after.
--
-- That mattered because deleting the channel was the ONLY way to replace a
-- revoked bot token — there was no `PATCH /channels/:id`. Rotating a
-- credential meant destroying the history of everything published with the
-- old one. The endpoint arrives with this migration; this half makes the
-- delete survivable even so.
--
-- WHY `SET NULL` AND NOT A SOFT DELETE ON `channels`. A soft delete keeps
-- more — the receipt would still resolve its channel's name through the FK —
-- but it only works if EVERY reader of `channels` learns to filter the dead
-- ones out, and they live in four packages (the api's content and runs
-- repositories, the worker's generate and publish repositories). A
-- half-adopted soft delete is worse than none: a deleted channel that still
-- answers a "which channels may this brand publish to?" query is a post sent
-- to a channel the user believes is gone. `SET NULL` needs no reader to
-- cooperate — every live query matches on a concrete id and an orphan is
-- invisible to all of them — and it is the shape `usage_ledger` already uses
-- for exactly this reasoning about money.
--
-- BOTH KEYS, NOT JUST `channel_id`. Nulling `channel_id` alone would have
-- moved the death one hop: the adaptation still cascades away, and the
-- publication with it.
--
-- WHAT A NULL `channel_id` COSTS, AND THE TOMBSTONE THAT PAYS IT. A receipt
-- whose pointers are all null still carries the link, the status and the
-- time, but can no longer say WHERE the post went. So `channel_name` and
-- `channel_platform` are stamped onto the surviving rows at the moment the
-- channel is deleted.
--
-- AS A TRIGGER, because `DELETE /channels/:id` is not the only way a channel
-- row disappears: a brand delete cascades into `channels` with no application
-- code in the path at all, and so does a hand-run `DELETE`. Repository code
-- would cover one path and miss the bulk ones. BEFORE DELETE, because the
-- foreign key's own `SET NULL` action runs after the row is gone — by then
-- `channel_id` no longer selects anything to stamp.
--
-- The columns are nullable and stay null for every live row on purpose: while
-- the channel exists it is the authority on its own name, and a copy kept
-- beside it would be a second answer free to drift. `channel_platform` carries
-- no CHECK, unlike every other platform column here, because it records what a
-- channel WAS: pinning history to today's platform list would make retiring a
-- platform fail on the tombstones of channels that used it.
--
-- ADDITIVE. Two nullable columns, one index, and two foreign keys relaxed from
-- CASCADE to SET NULL — no existing row is rewritten and no existing value can
-- stop being valid, so there is nothing here for a preflight to refuse.
ALTER TABLE "publications" DROP CONSTRAINT "publications_adaptation_id_adaptations_id_fk";
--> statement-breakpoint
ALTER TABLE "publications" DROP CONSTRAINT "publications_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "publications" ALTER COLUMN "adaptation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "channel_name" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "channel_platform" text;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_adaptation_id_adaptations_id_fk" FOREIGN KEY ("adaptation_id") REFERENCES "public"."adaptations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publications_channel_id_idx" ON "publications" USING btree ("channel_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION publications_stamp_deleted_channel() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Only ever writes columns that are still null, so re-running this over a
  -- row some earlier delete already stamped cannot rewrite history. (It cannot
  -- happen today — a channel id is deleted once — but the guard costs nothing
  -- and states which way the write is allowed to go.)
  UPDATE publications
     SET channel_name = COALESCE(channel_name, OLD.name),
         channel_platform = COALESCE(channel_platform, OLD.platform)
   WHERE channel_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS publications_stamp_deleted_channel ON "channels";--> statement-breakpoint
CREATE TRIGGER publications_stamp_deleted_channel
  BEFORE DELETE ON "channels"
  FOR EACH ROW EXECUTE FUNCTION publications_stamp_deleted_channel();
