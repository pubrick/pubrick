import { z } from "zod";

export const PLATFORM_IDS = [
  "telegram",
  "vk",
  "dzen",
  "vc_ru",
  "max",
  "bluesky",
  "mastodon",
  "x",
] as const;

/**
 * Credential fields each platform's publisher needs. Keyed by PLATFORM_IDS, so the
 * form asks for the right keys instead of a generic "token" for seven of eight
 * platforms. Keep in sync with the publishers added in later plans.
 */
export const PLATFORM_FIELDS: Record<(typeof PLATFORM_IDS)[number], readonly string[]> = {
  telegram: ["botToken", "chatId"],
  vk: ["accessToken", "groupId"],
  dzen: ["token"],
  vc_ru: ["token"],
  max: ["token"],
  bluesky: ["handle", "appPassword"],
  mastodon: ["instanceUrl", "accessToken"],
  x: ["apiKey", "apiSecret", "accessToken", "accessSecret"],
};

/** Fields that are not secrets — everything else renders as type="password". */
export const NON_SECRET_FIELDS = new Set(["chatId", "groupId", "handle", "instanceUrl"]);

/** A channel's display name, bounded identically wherever it is written. */
const channelName = z.string().min(1).max(200);

/**
 * The one shape a credentials bag may take, on the way IN, for every endpoint
 * that will encrypt one.
 *
 * Declared once and referenced by both `channelCreateSchema` and
 * `channelUpdateSchema` rather than written out twice, because the two are the
 * same decision: what a caller is allowed to hand over to be sealed with
 * `encryptJson`. A second copy is free to drift — a wider bound on one of them
 * is not a style difference, it is a different rule about what gets encrypted
 * and stored, arrived at by nobody.
 *
 * Values are bounded (4096) and the bag must be non-empty: an empty object
 * encrypts perfectly happily into a blob that decrypts to `{}`, which every
 * publisher's `credentialsSchema` then rejects at SEND time — a channel that
 * looks configured and fails at the moment it matters. Keys are not restricted
 * to `PLATFORM_FIELDS[platform]`: the publishers validate their own required
 * fields (`publisher.credentialsSchema`) at both the connection test and the
 * send, and a self-hoster running an adapter this package has never heard of
 * must still be able to store what it needs.
 */
const credentialsBag = z
  .record(z.string(), z.string().max(4096))
  .refine((o) => Object.keys(o).length > 0, {
    message: "credentials must not be empty",
  });

export const channelCreateSchema = z.object({
  brandId: z.string().uuid(),
  platform: z.enum(PLATFORM_IDS),
  name: channelName,
  credentials: credentialsBag,
});
export type ChannelCreate = z.infer<typeof channelCreateSchema>;

/**
 * Rename a channel, or replace its credentials — the endpoint that exists so
 * that ROTATING A REVOKED TOKEN IS NOT A DELETE.
 *
 * Platform tokens get revoked (a Telegram bot token most of all), and until
 * `PATCH /channels/:id` existed the only way to install a new one was to delete
 * the channel and add it again. That took every adaptation with it — scheduled
 * posts included — and, until the same change, every `publications` row too:
 * the record that anything had ever been published there.
 *
 * `platform` and `brandId` are deliberately absent, and neither is an
 * oversight. The stored credentials are meaningful only to one platform's
 * adapter, so changing `platform` in place would leave a channel whose secrets
 * belong to a different service — and it would silently retarget every
 * adaptation already queued against it. Moving a channel between brands does
 * the same to the brand/channel pairing every content item was created under.
 * Both are "delete it and make the one you meant".
 *
 * `credentials` REPLACES the stored bag rather than merging into it. A merge
 * would leave the old `botToken` in place beside a new `chatId`, which is the
 * one outcome a rotation must never produce; and a caller that wants to change
 * one field of a bag it cannot read back (no endpoint returns credentials, by
 * design) has no way to express a merge safely anyway.
 *
 * At least one field must be present: `PATCH {}` would otherwise report success
 * for having done nothing.
 */
export const channelUpdateSchema = z
  .object({
    name: channelName.optional(),
    credentials: credentialsBag.optional(),
  })
  .refine((o) => o.name !== undefined || o.credentials !== undefined, {
    message: "provide name, credentials, or both",
  });
export type ChannelUpdate = z.infer<typeof channelUpdateSchema>;
