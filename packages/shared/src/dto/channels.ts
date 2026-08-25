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

export const channelCreateSchema = z.object({
  brandId: z.string().uuid(),
  platform: z.enum(PLATFORM_IDS),
  name: z.string().min(1).max(200),
  credentials: z.record(z.string(), z.string().max(4096)).refine((o) => Object.keys(o).length > 0, {
    message: "credentials must not be empty",
  }),
});
export type ChannelCreate = z.infer<typeof channelCreateSchema>;
