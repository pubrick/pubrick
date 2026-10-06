import { INBOX_REPLY_STATUSES } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
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
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";

/** Independent normalized text inbox; AI-analysis samples are never its source of truth. */
export const inboxConversations = pgTable(
  "inbox_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    publicationId: uuid("publication_id").notNull(),
    postUrl: text("post_url").notNull(),
    title: text("title").notNull(),
    peerId: bigint("peer_id", { mode: "number" }).notNull(),
    rootId: integer("root_id").notNull(),
    activityRevision: integer("activity_revision").notNull().default(0),
    readRevision: integer("read_revision").notNull().default(0),
    resolvedRevision: integer("resolved_revision"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    collectionRevision: integer("collection_revision").notNull().default(0),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    olderOffsetId: integer("older_offset_id"),
    windowMaxId: integer("window_max_id"),
    hasOlder: boolean("has_older").notNull().default(false),
    collectionError: text("collection_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("inbox_conversations_scope_id_idx").on(t.orgId, t.brandId, t.id),
    uniqueIndex("inbox_conversations_provider_idx").on(
      t.orgId,
      t.brandId,
      t.publicationId,
      t.peerId,
      t.rootId,
    ),
    foreignKey({
      name: "inbox_conversations_brand_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    index("inbox_conversations_activity_idx").on(t.orgId, t.brandId, t.lastActivityAt, t.id),
    check(
      "inbox_conversations_revisions_check",
      sql`${t.activityRevision} >= 0 and ${t.readRevision} between 0 and ${t.activityRevision} and (${t.resolvedRevision} is null or ${t.resolvedRevision} between 0 and ${t.activityRevision}) and ${t.collectionRevision} >= 0`,
    ),
    check(
      "inbox_conversations_target_check",
      sql`${t.rootId} > 0 and abs(${t.peerId}) <= 9007199254740991 and ${t.peerId} <> 0 and length(${t.postUrl}) between 1 and 2048 and length(${t.title}) <= 512`,
    ),
    check(
      "inbox_conversations_window_check",
      sql`(${t.olderOffsetId} is null or ${t.olderOffsetId} > 0) and (${t.windowMaxId} is null or ${t.windowMaxId} > 0) and (not ${t.hasOlder} or ${t.olderOffsetId} is not null)`,
    ),
  ],
);
export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    providerMessageId: integer("provider_message_id").notNull(),
    body: text("body").notNull(),
    bodyTruncated: boolean("body_truncated").notNull().default(false),
    revision: integer("revision").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("inbox_messages_provider_idx").on(t.conversationId, t.providerMessageId),
    unique("inbox_messages_scope_id_idx").on(t.orgId, t.brandId, t.conversationId, t.id),
    foreignKey({
      name: "inbox_messages_conversation_fk",
      columns: [t.orgId, t.brandId, t.conversationId],
      foreignColumns: [inboxConversations.orgId, inboxConversations.brandId, inboxConversations.id],
    }).onDelete("cascade"),
    check(
      "inbox_messages_text_check",
      sql`length(trim(${t.body})) between 1 and 4000 and ${t.revision} >= 0 and ${t.providerMessageId} > 0`,
    ),
  ],
);
/** Append-only activity establishes bounded list windows despite later collection on old posts. */
export const inboxActivities = pgTable(
  "inbox_activities",
  {
    seq: bigserial("seq", { mode: "bigint" }).primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    activityAt: timestamp("activity_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "inbox_activities_conversation_fk",
      columns: [t.orgId, t.brandId, t.conversationId],
      foreignColumns: [inboxConversations.orgId, inboxConversations.brandId, inboxConversations.id],
    }).onDelete("cascade"),
    index("inbox_activities_scope_seq_idx").on(t.orgId, t.brandId, t.seq),
    index("inbox_activities_latest_idx").on(t.conversationId, t.seq),
  ],
);
export const inboxSenderPreviews = pgTable(
  "inbox_sender_previews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    actorId: text("actor_id").notNull(),
    sessionId: text("session_id").notNull(),
    accountGeneration: text("account_generation").notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    accountLabel: text("account_label").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "inbox_sender_previews_brand_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    index("inbox_sender_previews_expiry_idx").on(t.expiresAt),
    check(
      "inbox_sender_previews_account_check",
      sql`${t.accountId} > 0 and ${t.accountId} <= 9007199254740991 and length(${t.accountLabel}) between 1 and 256 and length(${t.accountGeneration}) = 64`,
    ),
  ],
);
export const inboxReplies = pgTable(
  "inbox_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    messageId: uuid("message_id").notNull(),
    actorId: text("actor_id").notNull(),
    operationKey: uuid("operation_key").notNull(),
    senderPreviewId: uuid("sender_preview_id").notNull(),
    messageRevision: integer("message_revision").notNull(),
    targetBody: text("target_body").notNull(),
    targetProviderMessageId: integer("target_provider_message_id").notNull(),
    messageFingerprint: text("message_fingerprint").notNull(),
    body: text("body").notNull(),
    senderLabel: text("sender_label").notNull(),
    accountId: bigint("account_id", { mode: "number" }).notNull(),
    accountGeneration: text("account_generation").notNull(),
    status: text("status", { enum: INBOX_REPLY_STATUSES }).notNull().default("sending"),
    externalMessageId: integer("external_message_id"),
    externalUrl: text("external_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    unique("inbox_replies_scope_id_idx").on(t.orgId, t.brandId, t.conversationId, t.id),
    uniqueIndex("inbox_replies_operation_idx").on(t.orgId, t.actorId, t.operationKey),
    uniqueIndex("inbox_replies_unsettled_idx")
      .on(t.conversationId)
      .where(sql`${t.status} in ('sending', 'unknown')`),
    foreignKey({
      name: "inbox_replies_message_fk",
      columns: [t.orgId, t.brandId, t.conversationId, t.messageId],
      foreignColumns: [
        inboxMessages.orgId,
        inboxMessages.brandId,
        inboxMessages.conversationId,
        inboxMessages.id,
      ],
    }).onDelete("cascade"),
    index("inbox_replies_conversation_idx").on(
      t.orgId,
      t.brandId,
      t.conversationId,
      t.createdAt,
      t.id,
    ),
    enumCheck("inbox_replies_status_check", t.status, INBOX_REPLY_STATUSES),
    check(
      "inbox_replies_body_check",
      sql`length(trim(${t.body})) between 1 and 4000 and ${t.messageRevision} >= 0 and length(${t.senderLabel}) between 1 and 256 and length(${t.accountGeneration}) = 64 and length(${t.messageFingerprint}) = 64 and length(trim(${t.targetBody})) between 1 and 4000 and ${t.targetProviderMessageId} > 0 and ${t.accountId} > 0 and ${t.accountId} <= 9007199254740991`,
    ),
    check(
      "inbox_replies_receipt_check",
      sql`(${t.externalMessageId} is null or ${t.externalMessageId} > 0) and (${t.externalUrl} is null or (${t.externalMessageId} is not null and length(${t.externalUrl}) between 1 and 2048)) and (${t.status} <> 'sent' or ${t.externalMessageId} is not null)`,
    ),
    check(
      "inbox_replies_resolution_check",
      sql`(${t.resolvedBy} is null) = (${t.resolvedAt} is null) and (${t.status} in ('confirmed_sent', 'confirmed_not_sent')) = (${t.resolvedAt} is not null) and (${t.status} = 'sending') = (${t.finishedAt} is null)`,
    ),
  ],
);
/** Short collection leases fence overlapping late readers; collection never queues AI work. */
export const inboxCollectionClaims = pgTable(
  "inbox_collection_claims",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    publicationId: uuid("publication_id").primaryKey(),
    id: uuid("id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "inbox_collection_claims_brand_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
  ],
);
/** Immutable provider evidence may arrive after a human verdict; it never rewrites that verdict. */
export const inboxReplyEvidence = pgTable(
  "inbox_reply_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    replyId: uuid("reply_id").notNull(),
    evidenceKey: text("evidence_key").notNull(),
    providerMessageId: integer("provider_message_id").notNull(),
    externalUrl: text("external_url"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inbox_reply_evidence_identity_idx").on(t.replyId, t.evidenceKey),
    foreignKey({
      name: "inbox_reply_evidence_reply_fk",
      columns: [t.orgId, t.brandId, t.conversationId, t.replyId],
      foreignColumns: [
        inboxReplies.orgId,
        inboxReplies.brandId,
        inboxReplies.conversationId,
        inboxReplies.id,
      ],
    }).onDelete("cascade"),
    index("inbox_reply_evidence_claim_idx").on(
      t.orgId,
      t.brandId,
      t.conversationId,
      t.replyId,
      t.receivedAt,
    ),
    check(
      "inbox_reply_evidence_bounds_check",
      sql`${t.providerMessageId} > 0 and length(${t.evidenceKey}) = 64 and (${t.externalUrl} is null or length(${t.externalUrl}) between 1 and 2048)`,
    ),
  ],
);
