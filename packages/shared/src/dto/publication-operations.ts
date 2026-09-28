import { z } from "zod";
import { PLATFORM_IDS } from "./channels.js";
import { DELIVERY_OUTCOMES, PUBLICATION_STATUSES, PUBLISH_FAILURE_REASONS } from "./content.js";

export const PUBLICATION_OPERATION_FILTERS = [
  "needs_attention",
  "scheduled",
  "published",
  "all",
] as const;
export type PublicationOperationFilter = (typeof PUBLICATION_OPERATION_FILTERS)[number];

export const publicationOperationsQuerySchema = z.object({
  filter: z.enum(PUBLICATION_OPERATION_FILTERS).default("needs_attention"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});
export type PublicationOperationsQuery = z.infer<typeof publicationOperationsQuerySchema>;

/** One adaptation, rather than one attempt: the outcome is the current safe verdict. */
export const publicationOperationDtoSchema = z.strictObject({
  id: z.uuid(),
  contentItemId: z.uuid(),
  title: z.string().nullable(),
  channelId: z.uuid(),
  channelName: z.string(),
  platform: z.enum(PLATFORM_IDS),
  deliveryOutcome: z.enum(DELIVERY_OUTCOMES),
  failureReason: z.enum(PUBLISH_FAILURE_REASONS).nullable(),
  scheduledAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  externalUrl: z.string().nullable(),
  assertedAt: z.iso.datetime().nullable(),
  assertedByName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type PublicationOperationDto = z.infer<typeof publicationOperationDtoSchema>;

export const publicationOperationsPageDtoSchema = z.strictObject({
  rows: z.array(publicationOperationDtoSchema),
  nextCursor: z.string().nullable(),
});
export type PublicationOperationsPageDto = z.infer<typeof publicationOperationsPageDtoSchema>;

/** Historical receipt after its channel was deleted; no dead post or channel pointers. */
export const archivedPublicationDtoSchema = z.strictObject({
  id: z.uuid(),
  channelName: z.string().nullable(),
  channelPlatform: z.string().nullable(),
  status: z.enum(PUBLICATION_STATUSES),
  externalUrl: z.string().nullable(),
  assertedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ArchivedPublicationDto = z.infer<typeof archivedPublicationDtoSchema>;

export const archivedPublicationsPageDtoSchema = z.strictObject({
  rows: z.array(archivedPublicationDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ArchivedPublicationsPageDto = z.infer<typeof archivedPublicationsPageDtoSchema>;

export const archivedPublicationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(4096).optional(),
});
export type ArchivedPublicationsQuery = z.infer<typeof archivedPublicationsQuerySchema>;
