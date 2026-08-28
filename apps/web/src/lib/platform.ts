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

/** Credential field ids are camelCase wire keys; humanize for the form label. */
export function credentialFieldLabel(field: string): string {
  const spaced = field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return (spaced.charAt(0).toUpperCase() + spaced.slice(1)).replace(/\bid\b/gi, "ID");
}
