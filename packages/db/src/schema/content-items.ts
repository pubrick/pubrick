import {
  ADAPTATION_STATUSES,
  CONTENT_ORIGINS,
  CONTENT_STATUSES,
  PUBLICATION_STATUSES,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands, channels } from "./content.js";
import { enumCheck } from "./enum-check.js";

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    title: text("title"),
    body: text("body").notNull(),
    status: text("status", { enum: CONTENT_STATUSES }).notNull().default("draft"),
    /** Defaults to `human`, which is what every row written before AI existed is. */
    origin: text("origin", { enum: CONTENT_ORIGINS }).notNull().default("human"),
    /**
     * Stamped by an explicit `POST /content/:id/opened` the item page fires once
     * after render — never as a side effect of the GET, which the future public
     * API and MCP server would also trip. Null here is half of the refusal to
     * publish text no human has read.
     */
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("content_items_org_id_idx").on(t.orgId),
    index("content_items_brand_id_idx").on(t.brandId),
    /**
     * Both value sets pinned in the database as well as in the types — see
     * `enumCheck`. `status` is the sharper of the two: `PINNED_ITEM_MESSAGE` in
     * apps/api is a `Record` over the statuses in which text is pinned, written
     * that way so a new status without a decision is a compile error, and a row
     * outside this set makes that lookup return `undefined` at runtime.
     */
    enumCheck("content_items_status_check", t.status, CONTENT_STATUSES),
    enumCheck("content_items_origin_check", t.origin, CONTENT_ORIGINS),
  ],
);

export const adaptations = pgTable(
  "adaptations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Per-channel override; falls back to the content item body when null. */
    body: text("body"),
    status: text("status", { enum: ADAPTATION_STATUSES }).notNull().default("pending"),
    /**
     * The adaptation body is what actually reaches the platform, so provenance
     * tracks it separately from the master item: an item a human wrote can still
     * carry AI-adapted channel bodies.
     */
    origin: text("origin", { enum: CONTENT_ORIGINS }).notNull().default("human"),
    /**
     * WHEN THIS CHANNEL'S POST GOES OUT — an INSTANT, and stored as one.
     *
     * `timestamptz`, like every other timestamp in this table, and the reason
     * is sharpest here. The value is an instant from the moment it is picked:
     * the browser turns the reader's local choice into one, the api parses it
     * into a `Date`, and pg-boss holds the same instant on its own
     * `timestamptz` `start_after`. Only the column was zoneless, and a zoneless
     * column does not hold an instant — it holds a wall clock plus an
     * assumption about whose.
     *
     * The assumption was drizzle's: it writes a `Date` as `toISOString()` and
     * reads a bare value back as if it were UTC, so the round trip agreed with
     * itself and with the queue. Nothing else did. `created_at` on this same
     * row is written by `now()`, which is the SESSION's wall clock, so on a
     * self-hosted Postgres running in a local zone the two columns of one row
     * sat hours apart — and any SQL that asked the obvious question
     * (`scheduled_at > now()`: is this post still in the future?) got the wrong
     * answer, silently, while every screen showed the time the user asked for.
     * The project's own compose file pins the database to UTC, which is what
     * made this survivable for a private deployment and stops being an argument
     * the moment somebody else runs the product on their own machine.
     *
     * `timestamptz` removes the assumption rather than documenting it: Postgres
     * stores the instant, and every writer — a `Date` from the api, `now()`
     * from either process — and every reader agrees on it in any session zone.
     * See `packages/db/src/timestamp-zone.test.ts`, which asserts exactly that
     * from a session that is deliberately not in UTC.
     */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("adaptations_org_id_idx").on(t.orgId),
    index("adaptations_content_item_id_idx").on(t.contentItemId),
    index("adaptations_channel_id_idx").on(t.channelId),
    /**
     * ONE UNDELIVERED ADAPTATION PER (ITEM, CHANNEL). The invariant every
     * writer already believed, and the only one here with a demonstrated
     * exploit.
     *
     * An adaptation IS the delivery: `approve` locks every adaptation of the
     * item in `pending | failed | scheduled` and enqueues one publish job for
     * each (`enqueuePublish`, keyed on the adaptation's own id), and the
     * worker sends `adaptations.body ?? contentItems.body` to
     * `adaptations.channel_id`. So a second row naming the same channel is not
     * a duplicate record — it is a second post. The publications indexes
     * cannot see it: `publications_one_in_flight_per_adaptation` and its
     * `published` sibling are both scoped to ONE adaptation, and two
     * adaptations are two claims, two sends and two live posts in a channel
     * whose reviewer approved one.
     *
     * Nothing in the product deliberately writes such a row, and that was the
     * whole problem: the only thing standing in the way was accidental.
     * `contentCreateSchema` had no duplicate refine (the run schema does), and
     * `create()` caught a repeated id only as a side effect of comparing the
     * resolved channel COUNT against the requested one — which reported it as
     * "one or more channels do not belong to this brand", a sentence about
     * tenancy for a request whose channels were all perfectly valid. Both are
     * fixed, and neither is the guarantee: any other writer (the generate
     * worker's fan-out, a future re-adaptation, the public API, a script) is
     * one bug away from the same row. This index is the guarantee.
     *
     * PARTIAL, AND SCOPED TO EXACTLY THE ROWS THAT NEED IT. `published` is
     * excluded because a published adaptation is history, not a delivery: it
     * is the one status `approve` never re-enqueues, `reject` never cancels
     * and the worker never picks up. Everything else IS deliverable — `failed`
     * included, and that is the point of writing the predicate this way round:
     * `approve` re-targets `failed`, so two failed rows for one channel would
     * still be two posts on the next Publish.
     *
     * Written `<> 'published'` rather than as a list of the deliverable
     * statuses, so it fails safe: a status added later is INSIDE the
     * constraint by default. A list would silently exempt it, which is the
     * failure mode that opened this hole in the first place.
     *
     * WHAT THIS DOES TO RE-ADAPTATION (increment 2c). Re-adapting a channel
     * that has not published yet is a rewrite of the text that channel will
     * ship — an UPDATE of the row's `body`, which is what `updateAdaptation`
     * already does and what this index is indifferent to. Re-adapting a
     * channel that HAS published is a new delivery, and it may insert a new
     * row alongside the `published` one: the old row is outside the predicate,
     * so the new one is the only live entry for that pair and the index admits
     * it. Neither case has to drop this index. What 2c must not do is leave
     * two deliverable rows for one channel at the same time — which is not a
     * restriction it could want, because that is the exploit.
     */
    uniqueIndex("adaptations_one_live_per_item_channel")
      .on(t.contentItemId, t.channelId)
      .where(sql`${t.status} <> 'published'`),
    /**
     * Both value sets pinned in the database as well as in the types — see
     * `enumCheck`. `status` carries the same `Record`-over-statuses argument as
     * the item's, via `PINNED_ADAPTATION_MESSAGE`, and one more that is
     * specific to this column: the index above is written as a predicate OVER
     * this value set, and a status outside the set would sit inside the
     * predicate meaning nothing anybody wrote down.
     */
    enumCheck("adaptations_status_check", t.status, ADAPTATION_STATUSES),
    enumCheck("adaptations_origin_check", t.origin, CONTENT_ORIGINS),
    /**
     * The parent key of `content_versions`' composite foreign key — see
     * `contentVersions` in generation.ts, which is where the invariant it
     * enforces is argued.
     *
     * Redundant as a UNIQUENESS claim: `id` alone is the primary key, so a pair
     * containing it cannot repeat. It exists because a composite FK must
     * reference a declared unique key on the parent, and this is the smallest
     * one that includes the column being tied down. The cost is one extra btree
     * on a low-volume table; the alternative is the invariant staying in a
     * comment.
     */
    unique("adaptations_id_content_item_id_key").on(t.id, t.contentItemId),
    /**
     * NOT CONSTRAINED, AND DELIBERATELY: that `channel_id`'s channel belongs to
     * the same brand as `content_item_id`'s item. The code does assume it —
     * `create()` resolves the requested channels with `WHERE org_id = ? AND
     * brand_id = ?` and the generate worker's fan-out does the same — and the
     * database does not enforce it. Weighed, and left to the application, for
     * three reasons that compound:
     *
     * 1. It is not expressible as a constraint between these two tables. The
     *    brand is a fact about the ITEM and about the CHANNEL, and neither is
     *    reachable from a row of this one. Making it expressible means
     *    denormalising `brand_id` ONTO adaptations, plus unique keys on
     *    `content_items (brand_id, id)` and `channels (brand_id, id)`, plus two
     *    composite foreign keys — a copy of a fact, kept in step by hand, in
     *    exchange for pinning the original.
     * 2. The new column would have to be NOT NULL to enforce anything at all
     *    (MATCH SIMPLE skips a pair containing a NULL), so every writer in
     *    apps/api and apps/worker would have to start filling it — a change to
     *    two other packages to enforce something neither of them gets wrong.
     * 3. apps/api's tenancy suite PLANTS the violating row on purpose
     *    (`otherOrgAdaptation` in content.e2e.spec.ts, filed from underneath the
     *    API because no endpoint will write it) to prove that the repository's
     *    own `org_id` predicate refuses to serve it. A constraint here would
     *    delete the premise of the tests that watch the real defence.
     *
     * What would change the answer: a second, independent writer of this table
     * — a public API, an importer, an MCP server — that does not go through
     * `create()`. Then the invariant would have more than one place to be got
     * wrong, and the denormalised column would start paying for itself.
     */
  ],
);

/**
 * Terminal outcome log: one row per delivery attempt that ended for good.
 *
 * **THIS TABLE OUTLIVES WHAT IT POINTS AT.** It is the durable record that a
 * platform accepted a message — the external id and the link the product's
 * "published, here it is" claim rests on — and that fact does not stop being
 * true when the channel is removed afterwards. `usage_ledger` already reasons
 * this way about money (`run_id`, `content_item_id`, `adaptation_id` and
 * `channel_id` are all `SET NULL` there: the money was spent whatever happened
 * next); a post that went out is the same kind of fact.
 *
 * Both of its own foreign keys are therefore nullable and `SET NULL`. Both are
 * load-bearing and neither is enough alone: `adaptations.channel_id` is
 * `CASCADE`, so a channel delete used to take the adaptations with it and the
 * publications with THEM — nulling `channel_id` alone would have left the row
 * to die one hop further along. Deleting a channel now leaves the receipt
 * standing with both pointers null.
 *
 * `org_id` stays `NOT NULL`/`CASCADE`, deliberately: deleting an organization
 * is tenant erasure, not bookkeeping, and a receipt no tenant owns is a row no
 * query in this codebase is allowed to reach.
 */
export const publications = pgTable(
  "publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Null once the adaptation is gone — which a channel delete causes
     * (`adaptations.channel_id` cascades) and a brand delete causes twice over.
     * Every live reader matches on a concrete id (`eq(adaptationId, x)`), so an
     * orphan is invisible to all of them, and both partial unique indexes below
     * are btree indexes where NULLs are distinct: any number of orphans may sit
     * beside the one live `published` row of a still-existing adaptation.
     */
    adaptationId: uuid("adaptation_id").references(() => adaptations.id, {
      onDelete: "set null",
    }),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    /**
     * WHICH CHANNEL THIS WENT TO, ONCE `channel_id` CAN NO LONGER SAY.
     *
     * A surviving row whose every pointer is null is a receipt with no
     * addressee: it still carries the link and the timestamp, but it can no
     * longer answer the question the reader actually asks, which is "where did
     * this post go?". So the channel's identity is copied onto the row at the
     * moment the channel is deleted, by the `publications_stamp_deleted_channel`
     * BEFORE DELETE trigger on `channels` (migration 0011).
     *
     * A TRIGGER RATHER THAN REPOSITORY CODE, for one reason: the API's own
     * `DELETE /channels/:id` is not the only way a channel row disappears. A
     * brand delete cascades into `channels` without any of this app's code
     * seeing it, and so does a hand-run `DELETE`. Stamping from the repository
     * would cover the one path and silently miss the rest — and the ones it
     * misses are exactly the bulk deletions where the most receipts are
     * orphaned at once.
     *
     * Null on every live row, and that is the rule rather than an omission:
     * while the channel exists it is the authority on its own name, and a copy
     * kept beside it would be a second answer free to drift. These two columns
     * are a TOMBSTONE — write-once, at the death of the thing they describe —
     * so a reader resolves the channel through `channel_id` when it is set and
     * falls back to these when it is not.
     *
     * `channel_platform` is plain `text`, with no `{ enum: ... }` and no check
     * constraint, unlike every other platform column in this schema. That is
     * deliberate: it records what a channel WAS, and pinning history to the
     * platform list of the day the row is read would make retiring a platform
     * fail on the tombstones of channels that used it.
     *
     * What is still lost, and is not pretended otherwise: an orphaned row's
     * link back to the CONTENT ITEM. The only path to it was the adaptation,
     * which a channel delete cascades away. The receipt says what went out and
     * where; it no longer says which draft it came from.
     */
    channelName: text("channel_name"),
    channelPlatform: text("channel_platform"),
    status: text("status", { enum: PUBLICATION_STATUSES }).notNull(),
    /** Platform message id; null when the platform returned no usable id. */
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    error: text("error"),
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("publications_org_id_idx").on(t.orgId),
    index("publications_adaptation_id_idx").on(t.adaptationId),
    /**
     * Postgres does not index a referencing column for you, and TWO things now
     * scan by it on every channel delete: the foreign key's own `SET NULL`
     * action, and the tombstone trigger's `UPDATE ... WHERE channel_id = OLD.id`.
     * Both used to be one seq scan of the whole table per deleted channel — a
     * brand delete multiplies that by its channel count. It is also the index a
     * reader listing one channel's publications will want.
     */
    index("publications_channel_id_idx").on(t.channelId),
    /**
     * At most one PUBLISHED RECORD per adaptation, as a database invariant
     * rather than a convention.
     *
     * This bounds the bookkeeping, not the sending. The worker's guards
     * (checking for an existing published publication, completing rather than
     * retrying a job once a platform accepted the post) are read-then-writes
     * that two workers can interleave, and this index is what stops such a
     * race from producing two contradictory `published` rows. What it cannot do
     * is stop a duplicate POST, because the send happens between the check and
     * the insert and this index only exists once the insert lands: any second
     * attempt inside that window posts again, and the index merely makes the
     * two posts agree on one row afterwards. The in-flight claim below is the
     * index that covers the window itself.
     *
     * Partial, so the many `failed` rows one adaptation may accumulate across
     * retries are unaffected.
     */
    uniqueIndex("publications_one_published_per_adaptation")
      .on(t.adaptationId)
      .where(sql`${t.status} = 'published'`),
    /**
     * At most one IN-FLIGHT CLAIM per adaptation — the half the index above
     * could never cover, because it is scoped to `published` and a claim is
     * written before anyone knows whether there will be a published row at all.
     *
     * This is what bounds the SENDING rather than the bookkeeping. The worker
     * inserts an `in_flight` row inside the same attempt that is about to call
     * the platform, and it is inserted BEFORE the call: whoever wins this index
     * is the only attempt allowed to send. The rows that used to be here — a
     * `published` row written after the send, and nothing at all before it —
     * left an attempt that died mid-send indistinguishable from an attempt that
     * never happened, and pg-boss redelivers on exactly that ambiguity (a
     * process killed after the send, a `complete()` that could not reach the
     * database, a graceful stop failing work in progress). A redelivered
     * attempt now finds the claim its predecessor never resolved, and refuses
     * to send instead of posting a second time.
     *
     * An attempt that gets a KNOWN-not-posted answer deletes its own claim
     * before handing the job back for a retry, so an honest transient failure
     * is not turned into a permanent block; every other ending resolves the
     * claim in place to `published`, `failed` or `unknown`. A claim that
     * outlives its attempt is therefore itself the evidence that the outcome is
     * unknown — see `claimSend` in
     * apps/worker/src/publish/publish.repository.ts.
     *
     * Partial, like its sibling: terminal rows are unaffected, and one
     * adaptation may accumulate as many of them as it has attempts.
     */
    uniqueIndex("publications_one_in_flight_per_adaptation")
      .on(t.adaptationId)
      .where(sql`${t.status} = 'in_flight'`),
    /**
     * Pinned in the database as well as in the types — see `enumCheck`. Both
     * indexes above are predicates over THIS value set, and `in_flight` is the
     * one status in it that means "an attempt is out there right now": a row
     * whose status is a near-miss of it is outside the partial index, claims
     * nothing, and lets a redelivered attempt send again.
     */
    enumCheck("publications_status_check", t.status, PUBLICATION_STATUSES),
  ],
);
