import { MAX_BODY_LENGTH, PLATFORM_MAX_TEXT_LENGTH } from "@pubrick/shared";

/**
 * Display names for platform ids. Ids are wire values (PLATFORM_IDS in
 * @pubrick/shared) and must never be shown raw in the UI.
 */
const PLATFORM_NAMES: Record<string, string> = {
  telegram: "Telegram",
  vk: "VK",
  dzen: "Dzen",
  vc_ru: "VC.ru",
  max: "MAX",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  x: "X",
};

export function platformName(id: string): string {
  return PLATFORM_NAMES[id] ?? id;
}

/** "Telegram · Main channel" — the one way a channel is named across screens. */
export function channelLabel(platform: string, name: string): string {
  return `${platformName(platform)} · ${name}`;
}

/**
 * How long an adaptation for this platform may be — the counter's denominator,
 * `min(platform limit, MAX_BODY_LENGTH)` (provenance-lens design §6).
 *
 * `MAX_BODY_LENGTH` is not padding: it bounds `adaptationUpdateSchema`, so a
 * counter promising vk's 16000 would invite text the product can never save.
 * The channel's own limit is the other half: showing `/ 4096` for an X channel
 * the adapter writes 280 characters for is the lie this function exists to
 * stop.
 *
 * **This is display only.** The `maxLength` attribute stays at
 * `MAX_BODY_LENGTH`: an existing override already longer than the platform
 * limit must stay editable, and a hard cap below its length would make it
 * permanently unfixable — the human could read the text and never shorten it.
 *
 * ⚠ The same number `adaptationLimit()` in `@pubrick/ai` computes for the
 * adapter, deliberately as a second implementation rather than an import:
 * `@pubrick/ai` is server-only (it pulls the model SDK), so the browser cannot
 * reach it, and `@pubrick/shared` — where one shared copy belongs — was being
 * edited by another change while this landed. What holds the two together
 * meanwhile is that both are pinned to `PLATFORM_MAX_TEXT_LENGTH` by tests in
 * their own packages (`lib/platform.test.ts` here,
 * `packages/ai/src/steps/steps.test.ts` there), so the rule cannot change in
 * one without failing the other. Folding them into one `@pubrick/shared`
 * helper is the follow-up.
 *
 * Unlike the adapter's copy, an unknown platform falls back rather than
 * throwing. There, a wrong limit spends the org's money generating unusable
 * text and failing loudly is right; here the worst case is a denominator that
 * is too generous, and a counter that throws takes the whole editor down with
 * it. `channels.platform` is a text column, so an id no build knows about can
 * reach this at runtime whatever the type says.
 */
export function adaptationLimit(platform: string): number {
  const limit = PLATFORM_MAX_TEXT_LENGTH[platform as keyof typeof PLATFORM_MAX_TEXT_LENGTH];
  return limit === undefined ? MAX_BODY_LENGTH : Math.min(limit, MAX_BODY_LENGTH);
}

/** Credential field ids are camelCase wire keys; humanize for the form label. */
export function credentialFieldLabel(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return (spaced.charAt(0).toUpperCase() + spaced.slice(1)).replace(/\bid\b/gi, "ID");
}
