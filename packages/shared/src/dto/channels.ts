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

export const channelCreateSchema = z.object({
  brandId: z.string().uuid(),
  platform: z.enum(PLATFORM_IDS),
  name: z.string().min(1).max(200),
  credentials: z.record(z.string(), z.string().max(4096)).refine((o) => Object.keys(o).length > 0, {
    message: "credentials must not be empty",
  }),
});
export type ChannelCreate = z.infer<typeof channelCreateSchema>;
