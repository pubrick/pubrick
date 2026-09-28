import { z } from "zod";
import { PLATFORM_IDS } from "./channels.js";
import { DELIVERY_OUTCOMES, PUBLISH_FAILURE_REASONS } from "./content.js";

/** A deliberately narrow machine-readable delivery projection. */
export const publicPublicationSchema = z.strictObject({
  id: z.uuid(),
  contentItemId: z.uuid(),
  channelId: z.uuid(),
  platform: z.enum(PLATFORM_IDS),
  deliveryOutcome: z.enum(DELIVERY_OUTCOMES),
  failureReason: z.enum(PUBLISH_FAILURE_REASONS).nullable(),
  scheduledAt: z.iso.datetime().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  externalUrl: z.string().nullable(),
  assertedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type PublicPublication = z.infer<typeof publicPublicationSchema>;
