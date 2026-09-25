import type { PlatformId } from "./dto/channels.js";

export const DEFAULT_CAMPAIGN_TEMPLATE = "cf_{content_type}_{YYYY_MM}";

/** Defaults inherited from the Content Factory campaign map. */
export const DEFAULT_UTM: Record<PlatformId, { source: string; medium: string }> = {
  telegram: { source: "tg_channel", medium: "post" },
  vk: { source: "vk_channel", medium: "post" },
  vc_ru: { source: "vc", medium: "article" },
  dzen: { source: "dzen", medium: "article" },
  instagram: { source: "instagram", medium: "social" },
  youtube: { source: "youtube", medium: "video" },
  rutube: { source: "rutube", medium: "video" },
  tenchat: { source: "tenchat", medium: "social" },
  max: { source: "max", medium: "post" },
  bluesky: { source: "bluesky", medium: "post" },
  mastodon: { source: "mastodon", medium: "post" },
  x: { source: "x", medium: "post" },
};
