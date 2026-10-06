import type { DirectPublishablePlatformId, PublishablePlatformId } from "@pubrick/shared";
import { blueskyPublisher } from "./bluesky.js";
import { facebookPagePublisher } from "./facebook-page.js";
import { linkedinPublisher } from "./linkedin.js";
import { mastodonPublisher } from "./mastodon.js";
import { maxPublisher } from "./max.js";
import { STAGED_PUBLISHABLE_PLATFORMS } from "./staged-registry.js";
import { telegramPublisher } from "./telegram.js";
import type { Publisher } from "./types.js";
import { vkPublisher } from "./vk.js";
import { wordpressPublisher } from "./wordpress.js";

/** Direct send adapters. Staged adapters have their own durable worker protocol. */
const PUBLISHERS: Record<DirectPublishablePlatformId, Publisher<never>> = {
  telegram: telegramPublisher as unknown as Publisher<never>,
  vk: vkPublisher as unknown as Publisher<never>,
  max: maxPublisher as unknown as Publisher<never>,
  bluesky: blueskyPublisher as unknown as Publisher<never>,
  mastodon: mastodonPublisher as unknown as Publisher<never>,
  wordpress: wordpressPublisher as unknown as Publisher<never>,
  linkedin: linkedinPublisher as unknown as Publisher<never>,
  facebook_page: facebookPagePublisher as unknown as Publisher<never>,
};

/**
 * Returns undefined for platforms whose adapter is not implemented yet.
 *
 * `Object.hasOwn` rather than a bare index read: `platform` comes from a
 * database column, and a plain object literal inherits `constructor`,
 * `toString`, `valueOf` and friends from Object.prototype. A row whose
 * platform is one of those names would return a truthy non-Publisher and blow
 * up later at `publisher.publish(...)` instead of being reported as "no
 * adapter for this platform".
 */
export function getPublisher(platform: string): Publisher<never> | undefined {
  const publishers: Record<string, Publisher<never>> = PUBLISHERS;
  return Object.hasOwn(publishers, platform) ? publishers[platform] : undefined;
}

/**
 * The ids this registry holds an adapter for, derived from the registry itself.
 *
 * Exported so a caller can enumerate rather than probe, and so the equality
 * with `PUBLISHABLE_PLATFORM_IDS` can be asserted at runtime as well as by the
 * compiler. Sorted and frozen: an accidental mutation here would be a change to
 * what the product claims it can publish to.
 */
export const PUBLISHABLE_PLATFORMS: readonly PublishablePlatformId[] = Object.freeze(
  ([...Object.keys(PUBLISHERS), ...STAGED_PUBLISHABLE_PLATFORMS] as PublishablePlatformId[]).sort(),
);
