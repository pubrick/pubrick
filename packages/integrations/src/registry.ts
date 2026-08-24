import { telegramPublisher } from "./telegram.js";
import type { Publisher } from "./types.js";

const PUBLISHERS: Record<string, Publisher<never>> = {
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
  return Object.hasOwn(PUBLISHERS, platform) ? PUBLISHERS[platform] : undefined;
}
