import { z } from "zod";
import {
  META_PUBLICATION_FAILURES,
  META_PUBLICATION_PHASES,
  META_STAGED_PLATFORM_IDS,
} from "../meta-publication.js";

export const META_PREPARATIONS_PAGE_SIZE = 20;
export const metaPreparationsQuerySchema = z.strictObject({ cursor: z.uuid().optional() });
export type MetaPreparationsQuery = z.infer<typeof metaPreparationsQuerySchema>;

/** A container is preparation evidence, never a published-post identity or an inspection link. */
export const metaPreparationSnapshotSchema = z.strictObject({
  stageId: z.uuid(),
  adaptationId: z.uuid(),
  platform: z.enum(META_STAGED_PLATFORM_IDS),
  phase: z.enum(META_PUBLICATION_PHASES),
  attempt: z.number().int().positive().max(2_147_483_647),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  containerId: z
    .string()
    .regex(/^[1-9][0-9]{0,30}$/)
    .nullable(),
  channelName: z.string().nullable(),
  reason: z.enum(META_PUBLICATION_FAILURES).nullable(),
  recoverable: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type MetaPreparationSnapshot = z.infer<typeof metaPreparationSnapshotSchema>;
export const metaPreparationsPageSchema = z.strictObject({
  stages: z.array(metaPreparationSnapshotSchema).max(META_PREPARATIONS_PAGE_SIZE),
  nextCursor: z.uuid().nullable(),
});
export type MetaPreparationsPage = z.infer<typeof metaPreparationsPageSchema>;

/** Binds the displayed preparation; the stage UUID is also required in the route. */
export const metaPreparationDiscardSchema = z.strictObject({
  expectedAttempt: z.number().int().positive().max(2_147_483_647),
  expectedInputHash: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgeNonpublicPreparation: z.literal(true),
});
export type MetaPreparationDiscard = z.infer<typeof metaPreparationDiscardSchema>;
export const metaPreparationDiscardedSchema = z.strictObject({
  stageId: z.uuid(),
  phase: z.literal("cancelled"),
});
export type MetaPreparationDiscarded = z.infer<typeof metaPreparationDiscardedSchema>;
