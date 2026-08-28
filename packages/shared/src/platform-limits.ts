import type { PLATFORM_IDS } from "./dto/channels.js";

/**
 * Maximum post length per platform, in characters.
 *
 * This lives here, as data, rather than on the `Publisher` interface: the
 * generation pipeline needs a limit for every platform a channel can exist
 * for, but only telegram has a publisher today. `telegramPublisher` reads
 * this same constant so the two cannot drift.
 */
export const PLATFORM_MAX_TEXT_LENGTH: Record<(typeof PLATFORM_IDS)[number], number> = {
  telegram: 4096,
  vk: 16000,
  dzen: 20000,
  vc_ru: 20000,
  max: 4000,
  bluesky: 300,
  mastodon: 500,
  x: 280,
};
