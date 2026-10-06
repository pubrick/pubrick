import { z } from "zod";
import { normalizeNewlines } from "../provenance.js";

export const INBOX_FILTERS = ["open", "resolved", "all"] as const;
export const INBOX_REPLY_STATUSES = [
  "sending",
  "sent",
  "failed",
  "unknown",
  "confirmed_sent",
  "confirmed_not_sent",
] as const;
export const INBOX_PAGE_SIZE = 20;
export const INBOX_MAX_REPLY_LENGTH = 4000;
const revision = z.number().int().nonnegative().max(2_147_483_647);
const cursor = z.string().max(1024).optional();
export const inboxQuerySchema = z
  .object({ filter: z.enum(INBOX_FILTERS).default("open"), cursor })
  .strict();
export const inboxPageQuerySchema = z.object({ cursor }).strict();
export const inboxCollectSchema = z.object({ publicationId: z.uuid() }).strict();
export const inboxOlderSchema = z.object({ expectedCollectionRevision: revision }).strict();
export const inboxStateSchema = z
  .object({ action: z.enum(["read", "resolve", "reopen"]), expectedActivityRevision: revision })
  .strict();
export const inboxReplySchema = z
  .object({
    operationKey: z.uuid(),
    senderPreviewId: z.uuid(),
    messageId: z.uuid(),
    expectedMessageRevision: revision,
    expectedMessageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    body: z
      .string()
      .transform(normalizeNewlines)
      .pipe(
        z
          .string()
          .min(1)
          .max(INBOX_MAX_REPLY_LENGTH)
          .refine((v) => Boolean(v.trim()) && !v.includes("\u0000")),
      ),
  })
  .strict();
export const inboxReplyResolutionSchema = z
  .object({
    senderPreviewId: z.uuid(),
    expectedStatus: z.enum(["sending", "unknown"]),
    outcome: z.enum(["sent", "not_sent"]),
    inspectedProvider: z.literal(true),
  })
  .strict();
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type InboxReplyInput = z.infer<typeof inboxReplySchema>;
export type InboxStateInput = z.infer<typeof inboxStateSchema>;
export type InboxReplyResolution = z.infer<typeof inboxReplyResolutionSchema>;
export type InboxReplyStatus = (typeof INBOX_REPLY_STATUSES)[number];
export type InboxConversationDto = {
  id: string;
  publicationId: string;
  postUrl: string;
  title: string;
  activityRevision: number;
  unread: boolean;
  resolved: boolean;
  lastActivityAt: string;
  collectionRevision: number;
  collectedAt: string | null;
  hasOlder: boolean;
  latestWindowLimit: number;
  collectionError: string | null;
};
export type InboxConversationPageDto = { rows: InboxConversationDto[]; nextCursor: string | null };
export type InboxMessageDto = {
  id: string;
  providerMessageId: number;
  body: string;
  bodyTruncated: boolean;
  revision: number;
  reviewFingerprint: string;
  publishedAt: string;
  editedAt: string | null;
};
export type InboxMessagesPageDto = { rows: InboxMessageDto[]; nextCursor: string | null };
export type InboxReplyDto = {
  id: string;
  messageId: string;
  body: string;
  status: InboxReplyStatus;
  senderLabel: string;
  targetMessageBody: string;
  targetProviderMessageId: number;
  externalMessageId: number | null;
  externalUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
  canResolve: boolean;
  providerReceipts: { messageId: number; url: string | null; receivedAt: string }[];
  receiptContradiction: boolean;
};
export type InboxDetailDto = {
  conversation: InboxConversationDto;
  messages: InboxMessagesPageDto;
  replies: InboxReplyDto[];
  accountConnected: boolean;
  applicationConfigured: boolean;
  publicationAvailable: boolean;
  canReply: boolean;
  canCollect: boolean;
  blockedReply: boolean;
};
export type InboxSenderPreviewDto = { id: string; accountLabel: string; expiresAt: string };
export type InboxPublicationDto = {
  id: string;
  title: string;
  channelName: string;
  url: string;
  createdAt: string;
};
export type InboxPublicationsPageDto = { rows: InboxPublicationDto[]; nextCursor: string | null };

const instant = z.iso.datetime();
export const inboxConversationDtoSchema = z
  .object({
    id: z.uuid(),
    publicationId: z.uuid(),
    postUrl: z.url(),
    title: z.string(),
    activityRevision: revision,
    unread: z.boolean(),
    resolved: z.boolean(),
    lastActivityAt: instant,
    collectionRevision: revision,
    collectedAt: instant.nullable(),
    hasOlder: z.boolean(),
    latestWindowLimit: z.literal(50),
    collectionError: z.string().nullable(),
  })
  .strict();
export const inboxConversationPageDtoSchema = z
  .object({
    rows: z.array(inboxConversationDtoSchema).max(INBOX_PAGE_SIZE),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const inboxMessageDtoSchema = z
  .object({
    id: z.uuid(),
    providerMessageId: z.number().int().positive(),
    body: z.string().max(4000),
    bodyTruncated: z.boolean(),
    revision,
    reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    publishedAt: instant,
    editedAt: instant.nullable(),
  })
  .strict();
export const inboxMessagesPageDtoSchema = z
  .object({
    rows: z.array(inboxMessageDtoSchema).max(INBOX_PAGE_SIZE),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const inboxReplyDtoSchema = z
  .object({
    id: z.uuid(),
    messageId: z.uuid(),
    body: z.string().max(4000),
    status: z.enum(INBOX_REPLY_STATUSES),
    senderLabel: z.string(),
    targetMessageBody: z.string().max(4000),
    targetProviderMessageId: z.number().int().positive(),
    externalMessageId: z.number().int().positive().nullable(),
    externalUrl: z.url().nullable(),
    createdAt: instant,
    finishedAt: instant.nullable(),
    canResolve: z.boolean(),
    providerReceipts: z
      .array(
        z
          .object({
            messageId: z.number().int().positive(),
            url: z.url().nullable(),
            receivedAt: instant,
          })
          .strict(),
      )
      .max(10),
    receiptContradiction: z.boolean(),
  })
  .strict();
export const inboxDetailDtoSchema = z
  .object({
    conversation: inboxConversationDtoSchema,
    messages: inboxMessagesPageDtoSchema,
    replies: z.array(inboxReplyDtoSchema).max(50),
    accountConnected: z.boolean(),
    applicationConfigured: z.boolean(),
    publicationAvailable: z.boolean(),
    canReply: z.boolean(),
    canCollect: z.boolean(),
    blockedReply: z.boolean(),
  })
  .strict();
