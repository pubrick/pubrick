import { instagramNativeStagedPublisher } from "./instagram-native.js";
import type { StagedPublisher } from "./staged-types.js";
import { threadsStagedPublisher } from "./threads.js";

/** Staged destinations use durable preparation and readiness before final delivery. */
const STAGED_PUBLISHERS: Readonly<Record<StagedPublishablePlatformId, StagedPublisher<never>>> =
  Object.freeze({
    threads: threadsStagedPublisher as unknown as StagedPublisher<never>,
    instagram_native: instagramNativeStagedPublisher as unknown as StagedPublisher<never>,
  });
export function getStagedPublisher(platform: string): StagedPublisher<never> | undefined {
  const publishers: Readonly<Record<string, StagedPublisher<never>>> = STAGED_PUBLISHERS;
  return Object.hasOwn(publishers, platform) ? publishers[platform] : undefined;
}
export const STAGED_PUBLISHABLE_PLATFORMS = Object.freeze(
  (Object.keys(STAGED_PUBLISHERS) as StagedPublishablePlatformId[]).sort(),
);

import type { StagedPublishablePlatformId } from "@pubrick/shared";
