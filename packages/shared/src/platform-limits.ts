import type { PLATFORM_IDS } from "./dto/channels.js";
import { MAX_BODY_LENGTH } from "./dto/content.js";

/**
 * Maximum post length per platform, in characters.
 *
 * This lives here, as data, rather than on the `Publisher` interface: the
 * generation pipeline needs a limit for every platform a channel can exist
 * for, but only telegram has a publisher today. `telegramPublisher` reads
 * this same constant so the two cannot drift.
 */
export const PLATFORM_MAX_TEXT_LENGTH: Record<(typeof PLATFORM_IDS)[number], number> = {
  telegram: 4096,
  vk: 16000,
  dzen: 20000,
  vc_ru: 20000,
  max: 4000,
  bluesky: 300,
  mastodon: 500,
  x: 280,
};

/**
 * How long an adaptation for this platform may be: `min(platform limit,
 * MAX_BODY_LENGTH)`.
 *
 * The second half is not padding. `MAX_BODY_LENGTH` bounds
 * `adaptationUpdateSchema`, so an adaptation longer than it would be
 * un-editable through the API forever — a human could read the text and never
 * fix it. Platforms whose own limit is larger (vk, dzen, vc_ru) are therefore
 * clamped to what the product can store.
 *
 * `undefined` for a platform id this build has no limit for. `channels.platform`
 * is a text column, so that is a runtime possibility whatever the types say, and
 * the two callers answer it differently **on purpose** — which is why the
 * decision is theirs and only the formula is here:
 *
 *  - `adaptationLimit` in `@pubrick/ai` throws a `PermanentError`. A missing
 *    limit there means generating against `Math.min(undefined, …)` → `NaN`, a
 *    `max(NaN)` that rejects nothing, and the org's money spent on unusable
 *    text.
 *  - `adaptationLimit` in `apps/web` falls back to `MAX_BODY_LENGTH`. There the
 *    worst case is a too-generous denominator under a counter, while a throw
 *    would take the whole editor down over a number that is only ever displayed.
 *
 * One implementation, because these two used to be two: the web copy was added
 * while this package was held by another change, with matching tests in both
 * packages standing in for the shared function that now exists.
 */
export function adaptationLimit(platform: string): number | undefined {
  const limit: number | undefined =
    PLATFORM_MAX_TEXT_LENGTH[platform as (typeof PLATFORM_IDS)[number]];
  return limit === undefined ? undefined : Math.min(limit, MAX_BODY_LENGTH);
}
