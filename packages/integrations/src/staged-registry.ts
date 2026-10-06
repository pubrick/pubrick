import { instagramNativeStagedPublisher } from "./instagram-native.js";
import type { StagedPublisher } from "./staged-types.js";
import { threadsStagedPublisher } from "./threads.js";

/** Transport foundation only. Public channel availability is a separate vertical gate. */
const STAGED_PUBLISHERS: Readonly<Record<string, StagedPublisher<never>>> = Object.freeze({
  threads: threadsStagedPublisher as unknown as StagedPublisher<never>,
  instagram_native: instagramNativeStagedPublisher as unknown as StagedPublisher<never>,
});
export function getStagedPublisher(platform: string): StagedPublisher<never> | undefined {
  return Object.hasOwn(STAGED_PUBLISHERS, platform) ? STAGED_PUBLISHERS[platform] : undefined;
}
