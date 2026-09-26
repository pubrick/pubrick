import type { ManualPlatformId } from "@pubrick/shared";
import {
  isManualPlatform,
  adaptationLimit as platformAdaptationLimit,
  TELEGRAM_LONG_POST_LENGTH,
} from "@pubrick/shared";

/**
 * Display names for platform ids. Ids are wire values (PLATFORM_IDS in
 * @pubrick/shared) and must never be shown raw in the UI.
 */
const PLATFORM_NAMES: Record<string, string> = {
  telegram: "Telegram",
  vk: "VK",
  dzen: "Dzen",
  vc_ru: "VC.ru",
  instagram: "Instagram",
  youtube: "YouTube",
  rutube: "RuTube",
  tenchat: "TenChat",
  t_j: "T—Ж",
  max: "MAX",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  x: "X",
};

export function platformName(id: string): string {
  return PLATFORM_NAMES[id] ?? id;
}

/** Manual editor homepages; opening these does not submit content. */
const MANUAL_PLATFORM_HOMES: Record<ManualPlatformId, string> = {
  vc_ru: "https://vc.ru/",
  dzen: "https://dzen.ru/",
  instagram: "https://www.instagram.com/",
  youtube: "https://www.youtube.com/",
  rutube: "https://rutube.ru/",
  tenchat: "https://tenchat.ru/",
  t_j: "https://t-j.ru/manual/",
};

export function manualPlatformHome(id: string): string | undefined {
  return isManualPlatform(id) ? MANUAL_PLATFORM_HOMES[id] : undefined;
}

/** "Telegram · Main channel" — the one way a channel is named across screens. */
export function channelLabel(platform: string, name: string): string {
  return `${platformName(platform)} · ${name}`;
}

/**
 * How long an adaptation for this platform may be — the counter's denominator,
 * the shared platform rule (provenance-lens design §6). Telegram adaptations
 * may be longer than the 4096-character master; other channel bodies may not.
 *
 * The formula is `@pubrick/shared`'s, and is the same one the adapter in
 * `@pubrick/ai` generates against: showing `/ 4096` for an X channel the model
 * writes 280 characters for is the lie this function exists to stop, and it
 * would come straight back if the two numbers were computed twice. (They were,
 * briefly: `@pubrick/ai` is server-only, so the browser cannot import it, and
 * the shared home for the rule was held by another change at the time.)
 *
 * **This is display only.** The `maxLength` attribute stays at the largest
 * channel body bound: an existing override already longer than the platform
 * limit must stay editable, and a hard cap below its length would make it
 * permanently unfixable — the human could read the text and never shorten it.
 * Over-limit is shown, never enforced here; see the provenance-lens design's §6.
 *
 * An unknown platform falls back to the largest channel-body DTO bound rather
 * than throwing, which is the opposite of
 * what the adapter does with it. There a wrong limit spends the org's money
 * generating unusable text, so failing loudly is right; here the worst case is
 * a denominator that is too generous, and a counter that throws takes the whole
 * editor down with it. `channels.platform` is a text column, so an id no build
 * knows about can reach this at runtime whatever the type says.
 */
export function adaptationLimit(platform: string): number {
  return platformAdaptationLimit(platform) ?? TELEGRAM_LONG_POST_LENGTH;
}

/** Credential field ids are camelCase wire keys; humanize for the form label. */
export function credentialFieldLabel(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return (spaced.charAt(0).toUpperCase() + spaced.slice(1))
    .replace(/\bid\b/gi, "ID")
    .replace(/\burl\b/gi, "URL");
}
