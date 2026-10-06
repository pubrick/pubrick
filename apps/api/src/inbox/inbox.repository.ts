import { createHash, randomUUID } from "node:crypto";
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { type BillingTransaction, schema } from "@pubrick/db";
import {
  hasOrganizationRole,
  INBOX_PAGE_SIZE,
  type InboxConversationDto,
  type InboxDetailDto,
  type InboxQuery,
  type InboxReplyDto,
  type InboxReplyInput,
  type InboxReplyResolution,
  type InboxStateInput,
  isPublicTelegramPostUrl,
} from "@pubrick/shared";
import {
  DiscussionError,
  type DiscussionPage,
  type DiscussionReplyReceipt,
} from "@pubrick/telegram";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict } from "../api-error";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";
import { authorizeTelegramSessionActor } from "../telegram-decisions/telegram-session-actor";
import { InboxTransport } from "./inbox.transport";

const conversations = schema.inboxConversations;
const messages = schema.inboxMessages;
const replies = schema.inboxReplies;
const previews = schema.inboxSenderPreviews;
const collections = schema.inboxCollectionClaims;
type Conversation = typeof conversations.$inferSelect;
type Reply = typeof replies.$inferSelect;
type Message = typeof messages.$inferSelect;
function requiredRow<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("inbox_expected_locked_row");
  return row;
}
function replay(row: Reply, brandId: string, id: string, input: InboxReplyInput) {
  if (
    row.brandId !== brandId ||
    row.conversationId !== id ||
    row.messageId !== input.messageId ||
    row.messageRevision !== input.expectedMessageRevision ||
    row.messageFingerprint !== input.expectedMessageFingerprint ||
    row.body !== input.body ||
    row.senderPreviewId !== input.senderPreviewId
  )
    throw conflict(
      "inbox_snapshot_changed",
      "This send operation belongs to a different reviewed reply",
    );
  return row;
}
const SENDER_TTL_SECONDS = 300;
const SETTLEMENT_GRACE_SECONDS = 60;
const cursorSchema = z
  .object({
    scope: z.string().length(64),
    window: z
      .string()
      .regex(/^\d{1,19}$/)
      .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n),
    at: z.iso.datetime(),
    id: z.uuid(),
  })
  .strict();
const messageCursorSchema = z
  .object({
    scope: z.string().length(64),
    upper: z.number().int().positive().max(2_147_483_647),
    last: z.number().int().positive().max(2_147_483_647),
  })
  .strict()
  .refine((value) => value.last <= value.upper);
const CONVERSATION_COLUMNS = {
  id: conversations.id,
  orgId: conversations.orgId,
  brandId: conversations.brandId,
  publicationId: conversations.publicationId,
  postUrl: conversations.postUrl,
  title: conversations.title,
  peerId: conversations.peerId,
  rootId: conversations.rootId,
  activityRevision: conversations.activityRevision,
  readRevision: conversations.readRevision,
  resolvedRevision: conversations.resolvedRevision,
  lastActivityAt: conversations.lastActivityAt,
  collectionRevision: conversations.collectionRevision,
  collectedAt: conversations.collectedAt,
  olderOffsetId: conversations.olderOffsetId,
  windowMaxId: conversations.windowMaxId,
  hasOlder: conversations.hasOlder,
  collectionError: conversations.collectionError,
  createdAt: conversations.createdAt,
};
const MESSAGE_COLUMNS = {
  id: messages.id,
  orgId: messages.orgId,
  brandId: messages.brandId,
  conversationId: messages.conversationId,
  providerMessageId: messages.providerMessageId,
  body: messages.body,
  bodyTruncated: messages.bodyTruncated,
  revision: messages.revision,
  publishedAt: messages.publishedAt,
  editedAt: messages.editedAt,
};
const REPLY_COLUMNS = {
  id: replies.id,
  orgId: replies.orgId,
  brandId: replies.brandId,
  conversationId: replies.conversationId,
  messageId: replies.messageId,
  actorId: replies.actorId,
  operationKey: replies.operationKey,
  senderPreviewId: replies.senderPreviewId,
  messageRevision: replies.messageRevision,
  messageFingerprint: replies.messageFingerprint,
  targetBody: replies.targetBody,
  targetProviderMessageId: replies.targetProviderMessageId,
  body: replies.body,
  senderLabel: replies.senderLabel,
  accountId: replies.accountId,
  accountGeneration: replies.accountGeneration,
  status: replies.status,
  externalMessageId: replies.externalMessageId,
  externalUrl: replies.externalUrl,
  // Keep outer correlation explicitly qualified: Drizzle single-table selections dequalify Column SQL chunks.
  providerReceipts: sql<
    InboxReplyDto["providerReceipts"]
  >`(select coalesce(jsonb_agg(jsonb_build_object('messageId', e.provider_message_id, 'url', e.external_url, 'receivedAt', to_char(e.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by e.received_at, e.id), '[]'::jsonb) from
    (select id, provider_message_id, external_url, received_at from inbox_reply_evidence where org_id = "inbox_replies"."org_id" and brand_id = "inbox_replies"."brand_id" and conversation_id = "inbox_replies"."conversation_id" and reply_id = "inbox_replies"."id" order by received_at desc, id desc limit 10) e)`,
  createdAt: replies.createdAt,
  finishedAt: replies.finishedAt,
  resolvedBy: replies.resolvedBy,
  resolvedAt: replies.resolvedAt,
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const scope = (...values: string[]) => digest(JSON.stringify(values));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode<T>(value: string | undefined, schema: z.ZodType<T>, expected: string): T | null {
  if (!value) return null;
  try {
    const parsed = schema.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
    if ((parsed as { scope: string }).scope !== expected) throw new Error("scope");
    return parsed;
  } catch {
    throw badRequest("invalid_request", "Invalid or mismatched inbox cursor");
  }
}
function conversationDto(row: Conversation): InboxConversationDto {
  return {
    id: row.id,
    publicationId: row.publicationId,
    postUrl: row.postUrl,
    title: row.title,
    activityRevision: row.activityRevision,
    unread: row.readRevision < row.activityRevision,
    resolved: row.resolvedRevision === row.activityRevision,
    lastActivityAt: new Date(row.lastActivityAt).toISOString(),
    collectionRevision: row.collectionRevision,
    collectedAt: row.collectedAt ? new Date(row.collectedAt).toISOString() : null,
    hasOlder: row.hasOlder,
    latestWindowLimit: 50,
    collectionError: row.collectionError,
  };
}
function messageFingerprint(row: Message) {
  return digest(
    JSON.stringify([
      row.orgId,
      row.brandId,
      row.conversationId,
      row.id,
      row.providerMessageId,
      row.revision,
      row.body,
      row.bodyTruncated,
      row.publishedAt.toISOString(),
      row.editedAt?.toISOString() ?? null,
    ]),
  );
}
function messageDto(row: Message) {
  return {
    id: row.id,
    providerMessageId: row.providerMessageId,
    body: row.body,
    bodyTruncated: row.bodyTruncated,
    revision: row.revision,
    reviewFingerprint: messageFingerprint(row),
    publishedAt: row.publishedAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}
function replyDto(
  row: Reply & { providerReceipts?: InboxReplyDto["providerReceipts"] },
  now: Date,
): InboxReplyDto {
  return {
    id: row.id,
    messageId: row.messageId,
    body: row.body,
    status: row.status,
    senderLabel: row.senderLabel,
    targetMessageBody: row.targetBody,
    targetProviderMessageId: row.targetProviderMessageId,
    externalMessageId: row.externalMessageId,
    externalUrl: row.externalUrl,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    providerReceipts: row.providerReceipts ?? [],
    receiptContradiction:
      ["failed", "confirmed_not_sent"].includes(row.status) &&
      Boolean(row.externalMessageId || row.providerReceipts?.length),
    canResolve:
      ["sending", "unknown"].includes(row.status) &&
      now.getTime() >= row.createdAt.getTime() + SETTLEMENT_GRACE_SECONDS * 1000,
  };
}
async function actor(tx: BillingTransaction, orgId: string, brandId: string) {
  await holdOrganization(tx, orgId);
  const userId = await authorizeTelegramSessionActor(tx, orgId);
  const authority = currentRequestAuthority();
  if (
    authority?.kind !== "session" ||
    authority.brandId !== brandId ||
    !(await authorizeRequestActor(tx, orgId))
  )
    throw new ForbiddenException("Current brand permission is required");
  return { userId, sessionId: authority.sessionId };
}
async function assertSessionCurrent(tx: BillingTransaction) {
  const authority = currentRequestAuthority();
  if (authority?.kind !== "session") throw new ForbiddenException("A current session is required");
  const [current] = await tx
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(
      and(
        eq(schema.session.id, authority.sessionId),
        sql`${schema.session.expiresAt} > clock_timestamp()`,
      ),
    );
  if (!current) throw new ForbiddenException("Session expired");
}
async function databaseNow(tx: BillingTransaction) {
  const result = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
  return new Date(requiredRow(result.rows[0]).now);
}
async function account(tx: BillingTransaction, orgId: string) {
  const [row] = await tx
    .select({
      cipher: schema.telegramSourceAccounts.sessionEncrypted,
      connectedAt: sql<string>`${schema.telegramSourceAccounts.connectedAt}::text`,
    })
    .from(schema.telegramSourceAccounts)
    .where(eq(schema.telegramSourceAccounts.orgId, orgId))
    .for("share");
  if (!row) throw conflict("inbox_account_unavailable", "Connect a workspace Telegram account");
  return { cipher: row.cipher, generation: digest(JSON.stringify([row.cipher, row.connectedAt])) };
}
async function livePublication(
  tx: BillingTransaction,
  orgId: string,
  brandId: string,
  publicationId: string,
) {
  const query = () =>
    tx
      .select({
        id: schema.publications.id,
        url: schema.publications.externalUrl,
        externalId: schema.publications.externalId,
        channelId: schema.channels.id,
        title: schema.contentItems.title,
      })
      .from(schema.publications)
      .innerJoin(
        schema.channels,
        and(
          eq(schema.channels.id, schema.publications.channelId),
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          eq(schema.channels.platform, "telegram"),
        ),
      )
      .innerJoin(
        schema.adaptations,
        and(
          eq(schema.adaptations.id, schema.publications.adaptationId),
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.channelId, schema.channels.id),
        ),
      )
      .innerJoin(
        schema.contentItems,
        and(
          eq(schema.contentItems.id, schema.adaptations.contentItemId),
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
        ),
      )
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.id, publicationId),
          eq(schema.publications.status, "published"),
        ),
      );
  const [before] = await query();
  if (!before) throw new NotFoundException();
  // No child item lock is acquired afterwards; channel retirement and receipt erasure cannot overtake the create boundary.
  await tx
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, before.channelId)))
    .for("key share");
  await tx
    .select({ id: schema.publications.id })
    .from(schema.publications)
    .where(and(eq(schema.publications.orgId, orgId), eq(schema.publications.id, publicationId)))
    .for("share");
  const [current] = await query();
  if (!current?.url || !isPublicTelegramPostUrl(current.url, current.externalId))
    throw conflict(
      "inbox_target_changed",
      "Only a live saved public Telegram publication discussion is supported",
    );
  return { ...current, url: current.url };
}
async function lockedConversation(
  tx: BillingTransaction,
  orgId: string,
  brandId: string,
  id: string,
) {
  const [row] = await tx
    .select(CONVERSATION_COLUMNS)
    .from(conversations)
    .where(
      and(
        eq(conversations.orgId, orgId),
        eq(conversations.brandId, brandId),
        eq(conversations.id, id),
      ),
    )
    .for("update");
  if (!row) throw new NotFoundException();
  return row;
}

@Injectable()
export class InboxRepository {
  constructor(private readonly transport: InboxTransport) {}

  async list(orgId: string, brandId: string, query: InboxQuery) {
    return db.transaction(async (tx) => {
      await actor(tx, orgId, brandId);
      const expected = scope(orgId, brandId, "conversations", query.filter);
      const position = decode(query.cursor, cursorSchema, expected);
      const max = await tx.execute<{ seq: string }>(
        sql`select coalesce(max(seq), 0)::text as seq from inbox_activities where org_id = ${orgId} and brand_id = ${brandId}`,
      );
      const window = position?.window ?? requiredRow(max.rows[0]).seq;
      // Select a historical latest activity before paging, not a mutable local page sort.
      const result = await tx.execute<Conversation & { activity_at: string }>(sql`
        with latest as (select distinct on (conversation_id) conversation_id, activity_at
          from inbox_activities where org_id = ${orgId} and brand_id = ${brandId} and seq <= ${window}::bigint
          order by conversation_id, seq desc)
        select c.id, c.org_id as "orgId", c.brand_id as "brandId", c.publication_id as "publicationId", c.post_url as "postUrl", c.title,
          c.peer_id::float8 as "peerId", c.root_id as "rootId", c.activity_revision as "activityRevision", c.read_revision as "readRevision", c.resolved_revision as "resolvedRevision",
          c.last_activity_at as "lastActivityAt", c.collection_revision as "collectionRevision", c.collected_at as "collectedAt", c.older_offset_id as "olderOffsetId",
          c.window_max_id as "windowMaxId", c.has_older as "hasOlder", c.collection_error as "collectionError", c.created_at as "createdAt",
          to_char(latest.activity_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as activity_at
        from inbox_conversations c inner join latest on latest.conversation_id = c.id
        where c.org_id = ${orgId} and c.brand_id = ${brandId}
          ${query.filter === "open" ? sql`and (c.resolved_revision is null or c.resolved_revision <> c.activity_revision)` : query.filter === "resolved" ? sql`and c.resolved_revision = c.activity_revision` : sql``}
          ${position ? sql`and (latest.activity_at, c.id) < (${position.at}::timestamptz, ${position.id}::uuid)` : sql``}
        order by latest.activity_at desc, c.id desc limit ${INBOX_PAGE_SIZE + 1}`);
      const rows = result.rows.slice(0, INBOX_PAGE_SIZE);
      const last = rows.at(-1);
      return {
        rows: rows.map((row) => ({ ...conversationDto(row), lastActivityAt: row.activity_at })),
        nextCursor:
          result.rows.length > INBOX_PAGE_SIZE && last
            ? encode({ scope: expected, window, at: last.activity_at, id: last.id })
            : null,
      };
    });
  }

  async publications(orgId: string, brandId: string, cursor?: string) {
    return db.transaction(async (tx) => {
      await actor(tx, orgId, brandId);
      const expected = scope(orgId, brandId, "publications");
      const position = decode(cursor, cursorSchema, expected);
      const result = await tx
        .select({
          id: schema.publications.id,
          title: schema.contentItems.title,
          channelName: schema.channels.name,
          url: schema.publications.externalUrl,
          externalId: schema.publications.externalId,
          createdAt: sql<string>`to_char(${schema.publications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(schema.publications)
        .innerJoin(
          schema.channels,
          and(
            eq(schema.channels.id, schema.publications.channelId),
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.brandId, brandId),
            eq(schema.channels.platform, "telegram"),
          ),
        )
        .innerJoin(
          schema.adaptations,
          and(
            eq(schema.adaptations.id, schema.publications.adaptationId),
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.channelId, schema.channels.id),
          ),
        )
        .innerJoin(
          schema.contentItems,
          and(
            eq(schema.contentItems.id, schema.adaptations.contentItemId),
            eq(schema.contentItems.orgId, orgId),
            eq(schema.contentItems.brandId, brandId),
          ),
        )
        .where(
          and(
            eq(schema.publications.orgId, orgId),
            eq(schema.publications.status, "published"),
            sql`${schema.publications.externalUrl} ~ '^https://t[.]me/[A-Za-z][A-Za-z0-9_]{4,31}/[1-9][0-9]{0,9}$'`,
            position
              ? sql`(${schema.publications.createdAt}, ${schema.publications.id}) < (${position.at}::timestamptz, ${position.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(schema.publications.createdAt), desc(schema.publications.id))
        .limit(INBOX_PAGE_SIZE + 1);
      const bounded = result.slice(0, INBOX_PAGE_SIZE);
      const last = bounded.at(-1);
      return {
        rows: bounded
          .filter((row) => isPublicTelegramPostUrl(row.url, row.externalId))
          .map(({ externalId: _id, ...row }) => ({
            ...row,
            title: row.title ?? "Telegram publication",
            url: row.url as string,
          })),
        nextCursor:
          result.length > INBOX_PAGE_SIZE && last
            ? encode({ scope: expected, window: "0", at: last.createdAt, id: last.id })
            : null,
      };
    });
  }

  private async messagePage(
    tx: BillingTransaction,
    orgId: string,
    brandId: string,
    id: string,
    cursor?: string,
  ) {
    const expected = scope(orgId, brandId, "messages", id);
    const position = decode(cursor, messageCursorSchema, expected);
    const rows = await tx
      .select(MESSAGE_COLUMNS)
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.brandId, brandId),
          eq(messages.conversationId, id),
          position
            ? sql`${messages.providerMessageId} <= ${position.upper} and ${messages.providerMessageId} < ${position.last}`
            : undefined,
        ),
      )
      .orderBy(desc(messages.providerMessageId))
      .limit(INBOX_PAGE_SIZE + 1);
    const page = rows.slice(0, INBOX_PAGE_SIZE);
    const last = page.at(-1);
    return {
      rows: page.map(messageDto),
      nextCursor:
        rows.length > INBOX_PAGE_SIZE && last
          ? encode({
              scope: expected,
              upper: position?.upper ?? requiredRow(page[0]).providerMessageId,
              last: last.providerMessageId,
            })
          : null,
    };
  }

  async detail(orgId: string, brandId: string, id: string): Promise<InboxDetailDto> {
    return db.transaction(async (tx) => {
      await actor(tx, orgId, brandId);
      const row = await lockedConversation(tx, orgId, brandId, id);
      const savedReplies = await tx
        .select(REPLY_COLUMNS)
        .from(replies)
        .where(
          and(
            eq(replies.orgId, orgId),
            eq(replies.brandId, brandId),
            eq(replies.conversationId, id),
          ),
        )
        .orderBy(desc(replies.createdAt), desc(replies.id))
        .limit(50);
      const [connected] = await tx
        .select({ id: schema.telegramSourceAccounts.orgId })
        .from(schema.telegramSourceAccounts)
        .where(eq(schema.telegramSourceAccounts.orgId, orgId));
      const authority = currentRequestAuthority();
      const roles = await tx
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, orgId),
            eq(schema.member.userId, authority?.kind === "session" ? authority.userId : ""),
          ),
        );
      const role = roles.map((member) => member.role).join(",");
      const canReply = hasOrganizationRole(role, ["owner", "admin", "member", "editor"]);
      const [live] = await tx
        .select({ id: schema.publications.id })
        .from(schema.publications)
        .innerJoin(
          schema.channels,
          and(
            eq(schema.channels.id, schema.publications.channelId),
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.brandId, brandId),
            eq(schema.channels.platform, "telegram"),
          ),
        )
        .innerJoin(
          schema.adaptations,
          and(
            eq(schema.adaptations.id, schema.publications.adaptationId),
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.channelId, schema.channels.id),
          ),
        )
        .innerJoin(
          schema.contentItems,
          and(
            eq(schema.contentItems.id, schema.adaptations.contentItemId),
            eq(schema.contentItems.orgId, orgId),
            eq(schema.contentItems.brandId, brandId),
          ),
        )
        .where(
          and(
            eq(schema.publications.orgId, orgId),
            eq(schema.publications.id, row.publicationId),
            eq(schema.publications.status, "published"),
            eq(schema.publications.externalUrl, row.postUrl),
          ),
        );
      const publicationAvailable = Boolean(live);
      const applicationConfigured = Boolean(env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH);
      const now = await databaseNow(tx);
      return {
        conversation: conversationDto(row),
        messages: await this.messagePage(tx, orgId, brandId, id),
        replies: savedReplies.map((reply) => replyDto(reply, now)),
        accountConnected: Boolean(connected),
        applicationConfigured,
        publicationAvailable,
        canReply,
        canCollect: Boolean(connected) && applicationConfigured && publicationAvailable,
        blockedReply: savedReplies.some((reply) => ["sending", "unknown"].includes(reply.status)),
      };
    });
  }

  async messageList(orgId: string, brandId: string, id: string, cursor?: string) {
    return db.transaction(async (tx) => {
      await actor(tx, orgId, brandId);
      await lockedConversation(tx, orgId, brandId, id);
      return this.messagePage(tx, orgId, brandId, id, cursor);
    });
  }

  async state(orgId: string, brandId: string, id: string, input: InboxStateInput) {
    return db.transaction(async (tx) => {
      await actor(tx, orgId, brandId);
      const row = await lockedConversation(tx, orgId, brandId, id);
      await assertSessionCurrent(tx);
      if (row.activityRevision !== input.expectedActivityRevision)
        throw conflict("inbox_snapshot_changed", "New discussion activity requires review");
      const [updated] = await tx
        .update(conversations)
        .set(
          input.action === "read"
            ? { readRevision: row.activityRevision }
            : input.action === "resolve"
              ? { readRevision: row.activityRevision, resolvedRevision: row.activityRevision }
              : { resolvedRevision: null },
        )
        .where(
          and(
            eq(conversations.orgId, orgId),
            eq(conversations.brandId, brandId),
            eq(conversations.id, id),
          ),
        )
        .returning(CONVERSATION_COLUMNS);
      return conversationDto(requiredRow(updated));
    });
  }

  async collect(
    orgId: string,
    brandId: string,
    publicationId: string,
    older?: { conversationId: string; expectedRevision: number },
  ) {
    const admission = await db.transaction(async (tx) => {
      await actor(tx, orgId, brandId);
      const publication = await livePublication(tx, orgId, brandId, publicationId);
      const connected = await account(tx, orgId);
      const id = randomUUID();
      const [claim] = await tx
        .insert(collections)
        .values({
          id,
          orgId,
          brandId,
          publicationId,
          expiresAt: sql`clock_timestamp() + interval '30 seconds'`,
        })
        .onConflictDoUpdate({
          target: collections.publicationId,
          set: { id, expiresAt: sql`clock_timestamp() + interval '30 seconds'` },
          setWhere: and(
            eq(collections.orgId, orgId),
            eq(collections.brandId, brandId),
            sql`${collections.expiresAt} <= clock_timestamp()`,
          ),
        })
        .returning({ id: collections.id });
      if (!claim)
        throw conflict("inbox_collection_busy", "A discussion collection is already in progress");
      const row = older ? await lockedConversation(tx, orgId, brandId, older.conversationId) : null;
      if (
        row &&
        (row.publicationId !== publicationId ||
          row.collectionRevision !== older?.expectedRevision ||
          !row.hasOlder)
      )
        throw conflict(
          "inbox_snapshot_changed",
          "Reload the collection window before reading older messages",
        );
      await assertSessionCurrent(tx);
      return { id, publication, connected, row };
    });
    try {
      const page = await this.transport.collect(admission.connected.cipher, {
        postUrl: admission.publication.url,
        ...(admission.row
          ? {
              identity: { peerId: admission.row.peerId, rootId: admission.row.rootId },
              offsetId: admission.row.olderOffsetId ?? 0,
              maxId: admission.row.windowMaxId ?? 0,
            }
          : {}),
      });
      return await db.transaction(async (tx) => {
        await actor(tx, orgId, brandId);
        const current = await livePublication(tx, orgId, brandId, publicationId);
        const connected = await account(tx, orgId);
        if (
          connected.generation !== admission.connected.generation ||
          current.url !== admission.publication.url
        )
          throw conflict(
            "inbox_snapshot_changed",
            "The account or publication changed during collection",
          );
        const [lease] = await tx
          .select({ id: collections.id })
          .from(collections)
          .where(
            and(
              eq(collections.orgId, orgId),
              eq(collections.brandId, brandId),
              eq(collections.publicationId, publicationId),
              eq(collections.id, admission.id),
              sql`${collections.expiresAt} > clock_timestamp()`,
            ),
          )
          .for("update");
        if (!lease)
          throw conflict("inbox_snapshot_changed", "A later collection replaced this request");
        const row = await this.savePage(
          tx,
          orgId,
          brandId,
          admission.publication,
          page,
          admission.row,
        );
        await tx
          .delete(collections)
          .where(and(eq(collections.orgId, orgId), eq(collections.id, admission.id)));
        return conversationDto(row);
      });
    } catch (error) {
      await db
        .delete(collections)
        .where(
          and(
            eq(collections.orgId, orgId),
            eq(collections.brandId, brandId),
            eq(collections.id, admission.id),
          ),
        )
        .catch(() => undefined);
      if (error instanceof DiscussionError)
        throw conflict(
          error.code === "target_changed" ? "inbox_target_changed" : "inbox_account_unavailable",
          "The Telegram discussion could not be read; check account access",
        );
      throw error;
    }
  }

  private async savePage(
    tx: BillingTransaction,
    orgId: string,
    brandId: string,
    publication: { id: string; url: string; title: string | null },
    page: DiscussionPage,
    previous: Conversation | null,
  ) {
    const [created] = await tx
      .insert(conversations)
      .values({
        orgId,
        brandId,
        publicationId: publication.id,
        postUrl: publication.url,
        title: (publication.title ?? "Telegram publication").slice(0, 512),
        peerId: page.peerId,
        rootId: page.rootId,
      })
      .onConflictDoNothing()
      .returning({ id: conversations.id });
    const [found] = await tx
      .select(CONVERSATION_COLUMNS)
      .from(conversations)
      .where(
        and(
          eq(conversations.orgId, orgId),
          eq(conversations.brandId, brandId),
          eq(conversations.publicationId, publication.id),
          eq(conversations.peerId, page.peerId),
          eq(conversations.rootId, page.rootId),
        ),
      )
      .for("update");
    if (!found) throw new Error("inbox_expected_locked_conversation");
    if (
      previous &&
      (found.id !== previous.id || found.collectionRevision !== previous.collectionRevision)
    )
      throw conflict("inbox_snapshot_changed", "The collection window changed");
    await assertSessionCurrent(tx);
    let changed = Boolean(created);
    for (const message of page.messages) {
      const [written] = await tx
        .insert(messages)
        .values({
          orgId,
          brandId,
          conversationId: found.id,
          providerMessageId: message.messageId,
          body: message.body,
          bodyTruncated: message.bodyTruncated,
          publishedAt: message.publishedAt,
          editedAt: message.editedAt,
        })
        .onConflictDoUpdate({
          target: [messages.conversationId, messages.providerMessageId],
          set: {
            body: message.body,
            bodyTruncated: message.bodyTruncated,
            editedAt: message.editedAt,
            revision: sql`${messages.revision} + 1`,
          },
          setWhere: sql`${messages.body} is distinct from ${message.body} or ${messages.bodyTruncated} is distinct from ${message.bodyTruncated} or ${messages.editedAt} is distinct from ${message.editedAt}`,
        })
        .returning({ id: messages.id });
      changed ||= Boolean(written);
    }
    const now = await databaseNow(tx);
    const [updated] = await tx
      .update(conversations)
      .set({
        collectionRevision: sql`${conversations.collectionRevision} + 1`,
        collectedAt: now,
        olderOffsetId: page.oldestId,
        windowMaxId: previous
          ? previous.windowMaxId
          : page.newestId
            ? Math.min(page.newestId + 1, 2_147_483_647)
            : null,
        hasOlder: page.hasMore && page.oldestId !== null,
        collectionError: null,
        ...(changed
          ? { activityRevision: sql`${conversations.activityRevision} + 1`, lastActivityAt: now }
          : {}),
      })
      .where(
        and(
          eq(conversations.orgId, orgId),
          eq(conversations.brandId, brandId),
          eq(conversations.id, found.id),
        ),
      )
      .returning(CONVERSATION_COLUMNS);
    if (changed)
      await tx
        .insert(schema.inboxActivities)
        .values({ orgId, brandId, conversationId: found.id, activityAt: now });
    return requiredRow(updated);
  }

  async older(orgId: string, brandId: string, id: string, expectedRevision: number) {
    const [row] = await db
      .select({ publicationId: conversations.publicationId })
      .from(conversations)
      .where(
        and(
          eq(conversations.orgId, orgId),
          eq(conversations.brandId, brandId),
          eq(conversations.id, id),
        ),
      );
    if (!row) throw new NotFoundException();
    return this.collect(orgId, brandId, row.publicationId, {
      conversationId: id,
      expectedRevision,
    });
  }

  async sender(orgId: string, brandId: string) {
    const admission = await db.transaction(async (tx) => {
      const user = await actor(tx, orgId, brandId);
      return { ...user, connected: await account(tx, orgId) };
    });
    let me: Awaited<ReturnType<InboxTransport["account"]>>;
    try {
      me = await this.transport.account(admission.connected.cipher);
    } catch {
      throw conflict(
        "inbox_account_unavailable",
        "The workspace Telegram account could not be verified",
      );
    }
    return db.transaction(async (tx) => {
      const user = await actor(tx, orgId, brandId);
      const connected = await account(tx, orgId);
      if (
        user.sessionId !== admission.sessionId ||
        connected.generation !== admission.connected.generation
      )
        throw conflict(
          "inbox_snapshot_changed",
          "The Telegram account changed; check the sender again",
        );
      await tx
        .delete(previews)
        .where(and(eq(previews.orgId, orgId), sql`${previews.expiresAt} <= clock_timestamp()`));
      const [preview] = await tx
        .insert(previews)
        .values({
          orgId,
          brandId,
          actorId: user.userId,
          sessionId: user.sessionId,
          accountGeneration: connected.generation,
          accountId: me.id,
          accountLabel: me.label.slice(0, 256) || "Telegram account",
          expiresAt: sql`clock_timestamp() + (${SENDER_TTL_SECONDS} * interval '1 second')`,
        })
        .returning({
          id: previews.id,
          accountLabel: previews.accountLabel,
          expiresAt: previews.expiresAt,
        });
      const savedPreview = requiredRow(preview);
      return { ...savedPreview, expiresAt: savedPreview.expiresAt.toISOString() };
    });
  }

  async reply(orgId: string, brandId: string, id: string, input: InboxReplyInput) {
    const admission = await db
      .transaction(async (tx) => {
        const user = await actor(tx, orgId, brandId);
        // Immutable operation identity survives HTTP retries and never invokes the provider twice.
        const [old] = await tx
          .select(REPLY_COLUMNS)
          .from(replies)
          .where(
            and(
              eq(replies.orgId, orgId),
              eq(replies.actorId, user.userId),
              eq(replies.operationKey, input.operationKey),
            ),
          );
        if (old)
          return { replay: replyDto(replay(old, brandId, id, input), await databaseNow(tx)) };
        const [read] = await tx
          .select(CONVERSATION_COLUMNS)
          .from(conversations)
          .where(
            and(
              eq(conversations.orgId, orgId),
              eq(conversations.brandId, brandId),
              eq(conversations.id, id),
            ),
          );
        if (!read) throw new NotFoundException();
        const publication = await livePublication(tx, orgId, brandId, read.publicationId);
        const connected = await account(tx, orgId);
        const row = await lockedConversation(tx, orgId, brandId, id);
        const [committed] = await tx
          .select(REPLY_COLUMNS)
          .from(replies)
          .where(
            and(
              eq(replies.orgId, orgId),
              eq(replies.actorId, user.userId),
              eq(replies.operationKey, input.operationKey),
            ),
          );
        if (committed)
          return { replay: replyDto(replay(committed, brandId, id, input), await databaseNow(tx)) };
        if (publication.url !== row.postUrl)
          throw conflict("inbox_target_changed", "The publication target changed");
        const [message] = await tx
          .select(MESSAGE_COLUMNS)
          .from(messages)
          .where(
            and(
              eq(messages.orgId, orgId),
              eq(messages.brandId, brandId),
              eq(messages.conversationId, id),
              eq(messages.id, input.messageId),
            ),
          )
          .for("share");
        if (
          !message ||
          message.revision !== input.expectedMessageRevision ||
          messageFingerprint(message) !== input.expectedMessageFingerprint ||
          message.bodyTruncated
        )
          throw conflict(
            "inbox_message_changed",
            "Review the complete latest message before replying",
          );
        const [blocked] = await tx
          .select({ id: replies.id })
          .from(replies)
          .where(
            and(
              eq(replies.orgId, orgId),
              eq(replies.brandId, brandId),
              eq(replies.conversationId, id),
              sql`${replies.status} in ('sending', 'unknown')`,
            ),
          );
        if (blocked)
          throw conflict(
            "inbox_reply_unsettled",
            "Inspect and settle the previous uncertain reply before sending",
          );
        const [preview] = await tx
          .select({
            id: previews.id,
            accountId: previews.accountId,
            accountLabel: previews.accountLabel,
            expiresAt: previews.expiresAt,
          })
          .from(previews)
          .where(
            and(
              eq(previews.orgId, orgId),
              eq(previews.brandId, brandId),
              eq(previews.id, input.senderPreviewId),
              eq(previews.actorId, user.userId),
              eq(previews.sessionId, user.sessionId),
              eq(previews.accountGeneration, connected.generation),
              isNull(previews.consumedAt),
              sql`${previews.expiresAt} > clock_timestamp()`,
            ),
          )
          .for("update");
        if (!preview || preview.expiresAt.getTime() <= (await databaseNow(tx)).getTime())
          throw conflict(
            "inbox_snapshot_changed",
            "Check the Telegram sender again before sending",
          );
        const replyId = randomUUID();
        await tx
          .update(previews)
          .set({ consumedAt: sql`clock_timestamp()` })
          .where(eq(previews.id, preview.id));
        await tx.insert(replies).values({
          id: replyId,
          orgId,
          brandId,
          conversationId: id,
          messageId: message.id,
          actorId: user.userId,
          operationKey: input.operationKey,
          senderPreviewId: preview.id,
          messageRevision: message.revision,
          messageFingerprint: input.expectedMessageFingerprint,
          targetBody: message.body,
          targetProviderMessageId: message.providerMessageId,
          body: input.body,
          senderLabel: preview.accountLabel,
          accountId: preview.accountId,
          accountGeneration: connected.generation,
        });
        return { claim: { replyId, user, connected, row, message, publication, preview } };
      })
      .catch((error: unknown) => {
        // Other conversations do not share the row lock, but this actor's operation identity is global.
        // Match only the exact unique fence; unrelated storage/constraint failures must remain errors.
        if (
          typeof error === "object" &&
          error !== null &&
          "cause" in error &&
          typeof error.cause === "object" &&
          error.cause !== null &&
          "code" in error.cause &&
          error.cause.code === "23505" &&
          "constraint" in error.cause &&
          error.cause.constraint === "inbox_replies_operation_idx"
        )
          throw conflict(
            "inbox_snapshot_changed",
            "This send operation belongs to another reviewed reply",
          );
        throw error;
      });
    if ("replay" in admission) return admission.replay;
    const claim = admission.claim;
    let createStarted = false;
    const sendDeadline = Date.now() + 20_000;
    try {
      const receipt = await this.transport.reply(claim.connected.cipher, {
        postUrl: claim.row.postUrl,
        identity: { peerId: claim.row.peerId, rootId: claim.row.rootId },
        message: {
          messageId: claim.message.providerMessageId,
          body: claim.message.body,
          bodyTruncated: claim.message.bodyTruncated,
          publishedAt: claim.message.publishedAt,
          editedAt: claim.message.editedAt,
        },
        body: input.body,
        randomId: (
          BigInt.asIntN(64, BigInt(`0x${digest(claim.replyId).slice(0, 16)}`)) || 1n
        ).toString(),
        expectedAccountId: claim.preview.accountId,
        beforeSend: async (sender, create) =>
          db.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('lock_timeout', '1000ms', true), set_config('statement_timeout', '2000ms', true)`,
            );
            const user = await actor(tx, orgId, brandId);
            const publication = await livePublication(tx, orgId, brandId, claim.row.publicationId);
            const connected = await account(tx, orgId);
            const row = await lockedConversation(tx, orgId, brandId, id);
            const [message] = await tx
              .select(MESSAGE_COLUMNS)
              .from(messages)
              .where(
                and(
                  eq(messages.orgId, orgId),
                  eq(messages.brandId, brandId),
                  eq(messages.conversationId, id),
                  eq(messages.id, claim.message.id),
                ),
              )
              .for("share");
            const [pending] = await tx
              .select({ id: replies.id })
              .from(replies)
              .where(
                and(
                  eq(replies.orgId, orgId),
                  eq(replies.brandId, brandId),
                  eq(replies.conversationId, id),
                  eq(replies.id, claim.replyId),
                  eq(replies.status, "sending"),
                  isNull(replies.resolvedAt),
                ),
              )
              .for("update");
            if (
              !pending ||
              user.userId !== claim.user.userId ||
              user.sessionId !== claim.user.sessionId ||
              connected.generation !== claim.connected.generation ||
              sender.id !== claim.preview.accountId ||
              publication.url !== claim.publication.url ||
              row.peerId !== claim.row.peerId ||
              row.rootId !== claim.row.rootId ||
              !message ||
              messageFingerprint(message) !== messageFingerprint(claim.message) ||
              message.revision !== claim.message.revision ||
              message.body !== claim.message.body ||
              message.bodyTruncated !== claim.message.bodyTruncated ||
              message.editedAt?.getTime() !== claim.message.editedAt?.getTime()
            )
              throw conflict(
                "inbox_snapshot_changed",
                "The reviewed reply or permission changed before sending",
              );
            // Re-read the database clock after every lock wait, immediately before provider create.
            const [fresh] = await tx
              .select({ id: schema.session.id, expiresAt: schema.session.expiresAt })
              .from(schema.session)
              .where(
                and(
                  eq(schema.session.id, user.sessionId),
                  sql`${schema.session.expiresAt} > clock_timestamp()`,
                ),
              );
            if (!fresh) throw new ForbiddenException("Session expired before send");
            const [currentPreview] = await tx
              .select({ id: previews.id, expiresAt: previews.expiresAt })
              .from(previews)
              .where(
                and(
                  eq(previews.id, claim.preview.id),
                  eq(previews.orgId, orgId),
                  eq(previews.brandId, brandId),
                  eq(previews.sessionId, user.sessionId),
                  eq(previews.accountGeneration, connected.generation),
                  sql`${previews.expiresAt} > clock_timestamp()`,
                ),
              );
            if (!currentPreview)
              throw conflict(
                "inbox_snapshot_changed",
                "The reviewed sender expired before sending",
              );
            const clockReadStarted = performance.now();
            const now = await databaseNow(tx);
            // Natural authority/proof expiry bounds the network create, as does the transport budget.
            // Charge the whole clock roundtrip conservatively rather than extending authority by network latency.
            const remaining =
              Math.min(
                sendDeadline - Date.now(),
                fresh.expiresAt.getTime() - now.getTime(),
                currentPreview.expiresAt.getTime() - now.getTime(),
              ) -
              (performance.now() - clockReadStarted);
            if (remaining <= 0) throw new DiscussionError("unavailable");
            const abort = new AbortController();
            let expired = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            // This boundary is INSIDE the locked transaction. The transport's outer race alone cannot release database locks.
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  expired = true;
                  abort.abort();
                  reject(new DiscussionError("unavailable", true));
                },
                Math.max(1, remaining),
              );
            });
            let accepted: DiscussionReplyReceipt;
            try {
              createStarted = true;
              const provider = create(abort.signal);
              void provider.then(
                (late) => {
                  if (expired)
                    void this.finish(orgId, brandId, id, claim.replyId, "sent", late).catch(
                      () => undefined,
                    );
                },
                () => undefined,
              );
              accepted = await Promise.race([provider, timeout]);
            } finally {
              if (timer) clearTimeout(timer);
              abort.abort();
            }
            await this.saveReceipt(tx, orgId, brandId, id, claim.replyId, accepted);
            return accepted;
          }),
      });
      // If a completion transaction committed but its acknowledgment failed, this exact claim is idempotent.
      await this.finish(orgId, brandId, id, claim.replyId, "sent", receipt);
    } catch (error) {
      await this.finish(
        orgId,
        brandId,
        id,
        claim.replyId,
        (error instanceof DiscussionError ? error.uncertain : createStarted) ? "unknown" : "failed",
        error instanceof DiscussionError ? error.receipt : undefined,
      ).catch(() => undefined);
    }
    return this.replyRecord(orgId, brandId, id, claim.replyId);
  }

  private async saveReceipt(
    tx: BillingTransaction,
    orgId: string,
    brandId: string,
    id: string,
    replyId: string,
    receipt: DiscussionReplyReceipt,
  ) {
    const exact = and(
      eq(replies.orgId, orgId),
      eq(replies.brandId, brandId),
      eq(replies.conversationId, id),
      eq(replies.id, replyId),
    );
    const [claim] = await tx.select({ id: replies.id }).from(replies).where(exact).for("update");
    if (!claim) return;
    await tx
      .insert(schema.inboxReplyEvidence)
      .values({
        orgId,
        brandId,
        conversationId: id,
        replyId,
        evidenceKey: digest(JSON.stringify([receipt.messageId, receipt.url])),
        providerMessageId: receipt.messageId,
        externalUrl: receipt.url,
      })
      .onConflictDoNothing();
    await tx
      .update(replies)
      .set({
        status: "sent",
        externalMessageId: receipt.messageId,
        externalUrl: receipt.url,
        finishedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          exact,
          sql`${replies.status} in ('sending', 'unknown')`,
          isNull(replies.resolvedAt),
          isNull(replies.externalMessageId),
        ),
      );
    // A later provider acceptance enriches only this original receipt. Human outcome and newer claims are untouched.
    await tx
      .update(replies)
      .set({ externalMessageId: receipt.messageId, externalUrl: receipt.url })
      .where(and(exact, isNull(replies.externalMessageId)));
    if (receipt.url)
      await tx
        .update(replies)
        .set({ externalUrl: receipt.url })
        .where(
          and(exact, eq(replies.externalMessageId, receipt.messageId), isNull(replies.externalUrl)),
        );
  }
  private async finish(
    orgId: string,
    brandId: string,
    id: string,
    replyId: string,
    status: "sent" | "unknown" | "failed",
    receipt?: DiscussionReplyReceipt,
  ) {
    // Bounded best effort; replay never sends again even when all recording attempts fail.
    const deadline = Date.now() + 6_000;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await db.transaction(async (tx) => {
          if (Date.now() >= deadline) throw new Error("receipt_recording_deadline");
          await tx.execute(
            sql`select set_config('lock_timeout', '1000ms', true), set_config('statement_timeout', '2000ms', true)`,
          );
          await holdOrganization(tx, orgId);
          const row = await lockedConversation(tx, orgId, brandId, id);
          if (!row) return;
          if (receipt) await this.saveReceipt(tx, orgId, brandId, id, replyId, receipt);
          else
            await tx
              .update(replies)
              .set({ status, finishedAt: sql`clock_timestamp()` })
              .where(
                and(
                  eq(replies.orgId, orgId),
                  eq(replies.brandId, brandId),
                  eq(replies.conversationId, id),
                  eq(replies.id, replyId),
                  eq(replies.status, "sending"),
                  isNull(replies.resolvedAt),
                ),
              );
        });
        return;
      } catch (error) {
        if (attempt === 2 || Date.now() >= deadline) throw error;
      }
    }
  }
  private async replyRecord(orgId: string, brandId: string, id: string, replyId: string) {
    return db.transaction(async (tx) => {
      await actor(tx, orgId, brandId);
      const [row] = await tx
        .select(REPLY_COLUMNS)
        .from(replies)
        .where(
          and(
            eq(replies.orgId, orgId),
            eq(replies.brandId, brandId),
            eq(replies.conversationId, id),
            eq(replies.id, replyId),
          ),
        );
      if (!row) throw new NotFoundException();
      return replyDto(row, await databaseNow(tx));
    });
  }
  async resolveReply(
    orgId: string,
    brandId: string,
    id: string,
    replyId: string,
    input: InboxReplyResolution,
  ) {
    return db.transaction(async (tx) => {
      const user = await actor(tx, orgId, brandId);
      const connected = await account(tx, orgId);
      const row = await lockedConversation(tx, orgId, brandId, id);
      const [reply] = await tx
        .select(REPLY_COLUMNS)
        .from(replies)
        .where(
          and(
            eq(replies.orgId, orgId),
            eq(replies.brandId, brandId),
            eq(replies.conversationId, row.id),
            eq(replies.id, replyId),
          ),
        )
        .for("update");
      const now = await databaseNow(tx);
      if (
        !reply ||
        reply.status !== input.expectedStatus ||
        reply.resolvedAt ||
        now.getTime() < reply.createdAt.getTime() + SETTLEMENT_GRACE_SECONDS * 1000
      )
        throw conflict(
          "inbox_snapshot_changed",
          "Reload this reply receipt; in-flight or settled requests cannot be changed",
        );
      const [preview] = await tx
        .select({ id: previews.id, accountId: previews.accountId, expiresAt: previews.expiresAt })
        .from(previews)
        .where(
          and(
            eq(previews.orgId, orgId),
            eq(previews.brandId, brandId),
            eq(previews.id, input.senderPreviewId),
            eq(previews.actorId, user.userId),
            eq(previews.sessionId, user.sessionId),
            eq(previews.accountGeneration, connected.generation),
            isNull(previews.consumedAt),
            sql`${previews.expiresAt} > clock_timestamp()`,
          ),
        )
        .for("update");
      if (
        !input.inspectedProvider ||
        !preview ||
        preview.accountId !== reply.accountId ||
        preview.expiresAt.getTime() <= (await databaseNow(tx)).getTime()
      )
        throw conflict(
          "inbox_reply_inspection_required",
          "Verify and inspect the original sending account before resolving this reply",
        );
      await tx
        .update(previews)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(eq(previews.id, preview.id));
      if (input.outcome === "not_sent" && reply.externalMessageId !== null)
        throw conflict(
          "inbox_reply_inspection_required",
          "An accepted message cannot be declared absent; inspect and remove it before a new reply",
        );
      await assertSessionCurrent(tx);
      const [updated] = await tx
        .update(replies)
        .set({
          status: input.outcome === "sent" ? "confirmed_sent" : "confirmed_not_sent",
          finishedAt: reply.finishedAt ?? now,
          resolvedBy: user.userId,
          resolvedAt: now,
        })
        .where(
          and(
            eq(replies.orgId, orgId),
            eq(replies.brandId, brandId),
            eq(replies.id, replyId),
            eq(replies.status, input.expectedStatus),
            isNull(replies.resolvedAt),
          ),
        )
        .returning(REPLY_COLUMNS);
      return replyDto(requiredRow(updated), now);
    });
  }
}
