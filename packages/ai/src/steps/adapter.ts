import { MAX_BODY_LENGTH, PermanentError, PLATFORM_MAX_TEXT_LENGTH } from "@pubrick/shared";
import { z } from "zod";
import { callStep } from "./prompt.js";
import type { Step } from "./types.js";

/** The platforms a channel can exist for. Keyed off the limits table so the two cannot drift. */
export type Platform = keyof typeof PLATFORM_MAX_TEXT_LENGTH;

/**
 * How long an adaptation for this platform may be.
 *
 * `min(platformLimit, MAX_BODY_LENGTH)`, and the second half is not padding:
 * `MAX_BODY_LENGTH` bounds `adaptationUpdateSchema`, so an adaptation longer
 * than it would be un-editable through the API forever — the human could read
 * the text but never fix it. Platforms whose own limit is larger (vk, dzen,
 * vc_ru) are therefore clamped to what the product can edit.
 */
export function adaptationLimit(platform: Platform): number {
  return Math.min(PLATFORM_MAX_TEXT_LENGTH[platform], MAX_BODY_LENGTH);
}

/** The channel a run adapts for. Not the drizzle row: this package has no database. */
export type StepChannel = { id: string; name: string; platform: Platform };

export type AdapterInput = { body: string };
export type AdaptationOutput = { body: string };

/**
 * The schema's own words for "too long", which double as the detector.
 *
 * The custom message travels twice: into the repair prompt, where it tells the
 * model the exact number it missed, and into the `PermanentError` message on a
 * second failure, where matching it distinguishes an overflow from any other
 * schema violation. Sniffing the generic "does not match the required schema"
 * text instead would report a missing body as a length problem.
 *
 * It carries no quotation marks or apostrophes on purpose: the message reaches
 * us through a JSON-encoded validation error, where those would be escaped.
 */
function overflowMarker(limit: number): string {
  return `must be at most ${limit} characters`;
}

/**
 * Step 5 — rewrite the approved draft for one channel, within its limit.
 *
 * One instance per channel, and its `name` is the per-channel checkpoint key
 * `adapter:<channelId>`: a single `adapter` key would make a crash mid-fan-out
 * re-run every channel that already succeeded, which is the re-spend
 * checkpoints exist to prevent.
 *
 * An over-long adaptation gets the one repair retry `generateStructured` gives
 * every schema violation, and then fails the run. It is never truncated: cutting
 * a post to length would publish text no human wrote and no human approved, and
 * the cut would land mid-sentence at exactly the character the platform counts
 * differently from us.
 */
export function adapterFor(channel: StepChannel): Step<AdapterInput, AdaptationOutput> {
  const limit = adaptationLimit(channel.platform);
  const marker = overflowMarker(limit);
  const schema = z.object({
    body: z
      .string()
      .min(1)
      .max(limit, { message: `the body ${marker} to fit this channel` }),
  });

  return {
    name: `adapter:${channel.id}`,
    schema,
    run: async (ctx, input) => {
      try {
        return await callStep(ctx, {
          schema,
          role: [
            `You rewrite an approved post for one channel: ${channel.name}, on ${channel.platform}.`,
            `The result must be at most ${limit} characters — characters, not words or tokens, counted including spaces, punctuation and any link.`,
            "Fitting the limit matters more than keeping every detail: cut the least important point rather than going over, and never end mid-sentence to make room.",
            "Keep the meaning, the facts and the voice of the draft. Do not add claims it does not make, and do not add hashtags or emoji unless the draft already uses them.",
          ],
          material: [{ label: "DRAFT", text: input.body }],
        });
      } catch (error) {
        // `instanceof Error` rather than `instanceof PermanentError`: the marker
        // is what identifies the failure, and a class check would silently stop
        // matching if two copies of @pubrick/shared ever ended up in the tree.
        if (error instanceof Error && error.message.includes(marker)) {
          throw new PermanentError(
            `the model could not fit ${channel.name}'s limit of ${limit} characters, twice`,
          );
        }
        throw error;
      }
    },
  };
}
