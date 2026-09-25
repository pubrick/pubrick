import {
  isPinnedAdaptationLimit,
  normalizeNewlines,
  PermanentError,
  PLATFORM_IDS,
  adaptationLimit as platformAdaptationLimit,
} from "@pubrick/shared";
import { z } from "zod";
import { withRunFailure } from "../classify.js";
import { defineStep } from "./prompt.js";
import { builtInAdapterRoleLines } from "./role-manifest.js";
import type { Step } from "./types.js";

/** The platforms a channel can exist for. */
export type Platform = (typeof PLATFORM_IDS)[number];

/**
 * How long an adaptation for this platform may be, or a `PermanentError`.
 *
 * The number itself — the platform limit within the channel-body bound — is
 * `@pubrick/shared`'s, so the bound this step generates against and the
 * denominator the editor's counter shows cannot drift apart. What is decided
 * *here* is the policy for a platform this build has no limit for.
 */
export function adaptationLimit(platform: Platform): number {
  const limit = platformAdaptationLimit(platform);
  // The type says this cannot happen; `channels.platform` is a text column, so
  // at runtime it can. Answering with a number anyway would mean generating
  // against a `max(NaN)` that rejects nothing, so the run stops here instead.
  // The editor's counter makes the opposite call on the same input — there the
  // worst case is a generous denominator, not money spent on unusable text.
  if (limit === undefined) {
    // `internal`, not a provider code: a channel row carrying a platform this
    // build has no limit for is our bug or our migration's, and the code the
    // user is shown must not blame the model for it.
    throw withRunFailure(
      new PermanentError(`no text limit is known for platform "${String(platform)}"`),
      "internal",
    );
  }
  return limit;
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
export type AdaptationOutput = { body: string; hashtags?: string[]; cta?: string };

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
export function adapterFor(
  channel: StepChannel,
  pinnedLimit?: number,
): Step<AdapterInput, AdaptationOutput> {
  const parsed = stepChannelSchema.safeParse(channel);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "channel"}: ${issue.message}`)
      .join("; ");
    throw withRunFailure(
      new PermanentError(
        `cannot build an adapter for platform "${String(channel?.platform)}": ${detail}`,
      ),
      "internal",
    );
  }
  const { id, name, platform } = parsed.data;
  const currentLimit = adaptationLimit(platform);
  if (pinnedLimit !== undefined && !isPinnedAdaptationLimit(platform, pinnedLimit)) {
    throw withRunFailure(
      new PermanentError(`unsupported pinned text limit for platform "${platform}"`),
      "internal",
    );
  }
  const limit = pinnedLimit ?? currentLimit;

  // The custom message is not how the overflow is detected — `isBodyTooLong`
  // does that from the issues. It is how the model is told what it missed: it
  // travels into the repair prompt, where "Too big: expected string to have
  // <=300 characters" says less than the number in the model's own terms.
  //
  // Normalised before it is bounded, exactly as `draftSchema` and the DTO's
  // `bodyText` are, and for the same reason: this body is stored in
  // `adaptations.body` and in an `ai` `content_versions` row, and a stored CR
  // is a character no `<textarea>` will hold. The `path[0] === "body"` the
  // repair loop reads is the PIPE's path, so wrapping the bound changes
  // nothing about how an overflow is detected or worded.
  const schema = z.object({
    // `overwrite`, not `transform().pipe()` — the pipe erased `maxLength`
    // from the JSON Schema the provider is sent, which for THIS step is the
    // platform limit the model most needs to be told. See writer.ts.
    body: z
      .string()
      .overwrite(normalizeNewlines)
      .min(1)
      .max(limit, {
        message: `the body must be at most ${limit} characters to fit this channel`,
      }),
    hashtags: z
      .array(
        z
          .string()
          .min(1)
          .max(80)
          .refine((tag) => !tag.includes("\0")),
      )
      .max(10)
      .optional(),
    cta: z
      .string()
      .max(500)
      .refine((text) => !text.includes("\0"))
      .optional(),
  });

  const step = defineStep<AdapterInput, AdaptationOutput>({
    name: `adapter:${id}`,
    schema,
    channelId: id,
    role: builtInAdapterRoleLines({ name, platform, limit }),
    material: (_ctx, input) => [{ label: "DRAFT", text: input.body }],
  });

  return {
    ...step,
    run: async (ctx, input) => {
      try {
        return await step.run(ctx, input);
      } catch (error) {
        if (isBodyTooLong(error)) {
          throw withRunFailure(
            new PermanentError(
              `the model could not fit ${name}'s limit of ${limit} characters, twice`,
            ),
            // Its own code rather than `no_structured_output`: the length rule
            // is the one schema rule a HUMAN can do something about — shorten
            // the brief, or drop the channel with the tightest limit.
            "too_long_for_channel",
          );
        }
        throw error;
      }
    },
  };
}
