import { telegramPublisher } from "./telegram.js";
import type { Publisher } from "./types.js";

const PUBLISHERS: Record<string, Publisher<never>> = {
  telegram: telegramPublisher as unknown as Publisher<never>,
};

/** Returns undefined for platforms whose adapter is not implemented yet. */
export function getPublisher(platform: string): Publisher<never> | undefined {
  return PUBLISHERS[platform];
}
