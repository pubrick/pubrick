import type { PublishablePlatformId } from "@pubrick/shared";
import { telegramPublisher } from "./telegram.js";
import type { Publisher } from "./types.js";

/**
 * Every platform Pubrick can deliver a post to — one entry per implemented
 * adapter, and the product's answer to "can this be published?".
 *
 * Annotated `Record<PublishablePlatformId, …>` rather than
 * `Record<string, …>`, which makes this map and `PUBLISHABLE_PLATFORM_IDS`
 * (`@pubrick/shared`) the same set by compilation rather than by diligence: an
 * adapter added here whose id is not declared there is an excess property, and
 * an id declared there with no adapter here is a missing one. Neither builds.
 *
 * That matters because the two are read from different sides of the wire. The
 * API refuses to create a channel for a platform this map has no entry for —
 * derived here, at the moment of creation — while the browser's platform
 * picker cannot import this package at all and reads the shared declaration
 * instead. Before both existed, the picker offered eight platforms, this map
 * held one, and the other seven could be connected, have credentials stored,
 * be adapted for by a paid model call, and then fail approval forever with
 * "no adapter for platform X".
 */
const PUBLISHERS: Record<PublishablePlatformId, Publisher<never>> = {
  telegram: telegramPublisher as unknown as Publisher<never>,
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
  (Object.keys(PUBLISHERS) as PublishablePlatformId[]).sort(),
);
