import {
  MAX_BODY_LENGTH,
  PermanentError,
  PLATFORM_IDS,
  PLATFORM_MAX_TEXT_LENGTH,
} from "@pubrick/shared";
import { z } from "zod";
import { defineStep } from "./prompt.js";
import type { Step } from "./types.js";

/** The platforms a channel can exist for. */
export type Platform = (typeof PLATFORM_IDS)[number];

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
  const limit: number | undefined = PLATFORM_MAX_TEXT_LENGTH[platform];
  // The type says this cannot happen; `channels.platform` is a text column, so
  // at runtime it can. Unchecked, the arithmetic below yields NaN and the run
  // fails much later with "limit of NaN characters" — or, worse, a `max(NaN)`
  // that rejects nothing at all.
  if (limit === undefined) {
    throw new PermanentError(`no text limit is known for platform "${String(platform)}"`);
  }
  return Math.min(limit, MAX_BODY_LENGTH);
}

/** The channel a run adapts for. Not the drizzle row: this package has no database. */
export type StepChannel = { id: string; name: string; platform: Platform };

/**
 * Checked at the boundary, because `StepChannel` is a hand-written type over
 * rows this package did not read. An unknown platform is the one that matters:
 * it silently produced a `NaN` limit before this existed.
 */
const stepChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.enum(PLATFORM_IDS),
});

export type AdapterInput = { body: string };
export type AdaptationOutput = { body: string };

/**
 * Was this failure the body being too long?
 *
 * Read from the **structured** validation issues, never from the error's
 * rendered message. That message quotes the model's own output back verbatim,
 * so a model can write any sentence into it — including one that looks like a
 * length complaint. A post *about* character limits ("Bluesky posts must be at
 * most 300 characters") returned under a misspelled key would otherwise be
 * reported to the user as a limit failure, hiding the real defect.
 *
 * `generateStructured` attaches the originating error as `cause`; the issues sit
 * a few links down that chain (`NoObjectGeneratedError` → `TypeValidationError`
 * → `ZodError`), so the walk is by shape rather than by depth.
 */
function isBodyTooLong(error: unknown): boolean {
  let node: unknown = error;
  for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
    const issues = (node as { issues?: unknown }).issues;
    if (Array.isArray(issues)) {
      return issues.some((issue: unknown) => {
        const { code, path } = (issue ?? {}) as { code?: unknown; path?: unknown };
        return code === "too_big" && Array.isArray(path) && path[0] === "body";
      });
    }
    node = (node as { cause?: unknown }).cause;
  }
  return false;
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
  const parsed = stepChannelSchema.safeParse(channel);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "channel"}: ${issue.message}`)
      .join("; ");
    throw new PermanentError(
      `cannot build an adapter for platform "${String(channel?.platform)}": ${detail}`,
    );
  }
  const { id, name, platform } = parsed.data;
  const limit = adaptationLimit(platform);

  // The custom message is not how the overflow is detected — `isBodyTooLong`
  // does that from the issues. It is how the model is told what it missed: it
  // travels into the repair prompt, where "Too big: expected string to have
  // <=300 characters" says less than the number in the model's own terms.
  const schema = z.object({
    body: z
      .string()
      .min(1)
      .max(limit, { message: `the body must be at most ${limit} characters to fit this channel` }),
  });

  const step = defineStep<AdapterInput, AdaptationOutput>({
    name: `adapter:${id}`,
    schema,
    channelId: id,
    role: [
      `You rewrite an approved post for one channel: ${name}, on ${platform}.`,
      `The result must be at most ${limit} characters — characters, not words or tokens, counted including spaces, punctuation and any link.`,
      "Fitting the limit matters more than keeping every detail: cut the least important point rather than going over, and never end mid-sentence to make room.",
      "Keep the meaning, the facts and the voice of the draft. Do not add claims it does not make, and do not add hashtags or emoji unless the draft already uses them.",
    ],
    material: (_ctx, input) => [{ label: "DRAFT", text: input.body }],
  });

  return {
    ...step,
    run: async (ctx, input) => {
      try {
        return await step.run(ctx, input);
      } catch (error) {
        if (isBodyTooLong(error)) {
          throw new PermanentError(
            `the model could not fit ${name}'s limit of ${limit} characters, twice`,
          );
        }
        throw error;
      }
    },
  };
}
