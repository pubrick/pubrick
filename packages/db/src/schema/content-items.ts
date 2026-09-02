import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands, channels } from "./content.js";

/** Draft lifecycle. `approved` means every adaptation was queued or scheduled. */
export const CONTENT_STATUSES = ["draft", "approved", "rejected", "published", "failed"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Per-channel delivery lifecycle. */
export const ADAPTATION_STATUSES = [
  "pending",
  "scheduled",
  "queued",
  "publishing",
  "published",
  "failed",
] as const;
export type AdaptationStatus = (typeof ADAPTATION_STATUSES)[number];

/**
 * What one delivery attempt is, or ended as.
 *
 * `in_flight` is the only non-terminal one, and it is written BEFORE the
 * request goes to the platform rather than after it comes back — it is the
 * claim that says "an attempt is out there". `unknown` is what a claim becomes
 * when the attempt never came back to resolve it: the request left, the answer
 * did not, and nobody can say from here whether a post is live. Neither is a
 * failure and neither is a success; a human has to look at the channel.
 */
export const PUBLICATION_STATUSES = ["in_flight", "published", "failed", "unknown"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/**
 * Who wrote the text. Lives here rather than in `generation.ts` because the
 * first columns using it are these two, and the reverse direction would make
 * the two schema modules import each other.
 */
export const CONTENT_ORIGINS = ["ai", "human"] as const;
export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

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
    firstOpenedAt: timestamp("first_opened_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("content_items_org_id_idx").on(t.orgId),
    index("content_items_brand_id_idx").on(t.brandId),
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
    scheduledAt: timestamp("scheduled_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("adaptations_org_id_idx").on(t.orgId),
    index("adaptations_content_item_id_idx").on(t.contentItemId),
    index("adaptations_channel_id_idx").on(t.channelId),
  ],
);

/** Terminal outcome log: one row per delivery attempt that ended for good. */
export const publications = pgTable(
  "publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    adaptationId: uuid("adaptation_id")
      .notNull()
      .references(() => adaptations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    status: text("status", { enum: PUBLICATION_STATUSES }).notNull(),
    /** Platform message id; null when the platform returned no usable id. */
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    error: text("error"),
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("publications_org_id_idx").on(t.orgId),
    index("publications_adaptation_id_idx").on(t.adaptationId),
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
  ],
);
