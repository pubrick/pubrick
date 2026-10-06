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

export const publicationOperationsQuerySchema = z
  .object({
    filter: z.enum(PUBLICATION_OPERATION_FILTERS).default("needs_attention"),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(4096).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    channelId: z.uuid().optional(),
  })
  .superRefine((query, ctx) => {
    if ((query.from === undefined) !== (query.to === undefined)) {
      ctx.addIssue({ code: "custom", message: "from and to must be supplied together" });
    }
    if (query.from && query.to) {
      const span = Date.parse(query.to) - Date.parse(query.from);
      if (query.filter !== "scheduled" || span <= 0 || span > 93 * 86_400_000) {
        ctx.addIssue({ code: "custom", message: "A scheduled range must span at most 93 days" });
      }
    }
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
  attemptCount: z.number().int().nonnegative(),
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

/** A complete, reviewed move set; jobs and timestamps change atomically. */
export const publicationMoveSchema = z.strictObject({
  adaptationId: z.uuid(),
  expectedScheduledAt: z.iso.datetime(),
  expectedAttemptCount: z.number().int().nonnegative(),
  scheduledAt: z.iso.datetime(),
});
export const publicationMovesSchema = z
  .strictObject({
    moves: z.array(publicationMoveSchema).min(1).max(20),
  })
  .superRefine(({ moves }, ctx) => {
    if (new Set(moves.map((move) => move.adaptationId)).size !== moves.length) {
      ctx.addIssue({ code: "custom", message: "Each delivery may appear only once" });
    }
  });
export type PublicationMoves = z.infer<typeof publicationMovesSchema>;
export const publicationMoveResultSchema = z.strictObject({
  moves: z
    .array(
      z.strictObject({
        adaptationId: z.uuid(),
        scheduledAt: z.iso.datetime(),
        attemptCount: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(20),
});
export type PublicationMoveResult = z.infer<typeof publicationMoveResultSchema>;

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
