import { CLAIMS_TO_VERIFY_LABEL } from "@pubrick/shared";
import { z } from "zod";
import { defineStep } from "./prompt.js";
import type { Step } from "./types.js";

/**
 * What this step's output is called, everywhere a human can read it.
 *
 * DEFINED IN `@pubrick/shared` and only re-exported here, so the prompt below
 * and the label `apps/web` prints in the run checklist are one string rather
 * than two that agree today. `apps/web` is a UI-only app and does not depend on
 * this package; shared is the one both sides already have. Re-exported from here
 * because this step is what the phrase belongs to: nothing here is checked
 * against anything, and that is the whole point of the wording.
 */
export { CLAIMS_TO_VERIFY_LABEL };

/**
 * Claims found in the draft.
 *
 * An empty list is valid: a post can make no factual claim at all, and a schema
 * that demanded one would produce an invented claim to fill the slot.
 */
export const factcheckSchema = z.object({
  claims: z.array(
    z.object({
      text: z.string().min(1),
      needsCheck: z.boolean(),
    }),
  ),
});
export type FactcheckOutput = z.infer<typeof factcheckSchema>;

export type FactcheckInput = { body: string };

/**
 * Step 4 — list the claims, check none of them.
 *
 * With no sources and no retrieval in this increment, this step **verifies
 * nothing**: it reads the draft and lists what a person would have to confirm
 * before publishing. The list rides with the draft into the review queue under
 * the heading `CLAIMS_TO_VERIFY_LABEL`, and no string anywhere — instructions,
 * schema, API or UI — may suggest a check happened. Increment 3 makes it real
 * against the source article; until then, saying otherwise would be the exact
 * slop this product exists to oppose.
 */
export const FACTCHECK: Step<FactcheckInput, FactcheckOutput> = defineStep({
  name: "factcheck",
  schema: factcheckSchema,
  role: [
    `You read a draft post and list the factual claims it makes, so that a person can verify them before it is published. The list is shown to that person under the heading "${CLAIMS_TO_VERIFY_LABEL}".`,
    "You have no sources and no way to look anything up, so you check nothing and decide nothing about whether a claim is true. Never say or imply that a claim has been checked, and never add a claim the draft does not make.",
    "Produce, for each claim:",
    "- text: the claim in one sentence, as the draft states it.",
    "- needsCheck: true when a reader could reasonably ask whether it is true — numbers, dates, prices, comparisons, superlatives, attributions, anything about the world outside the post. False for common knowledge and for plainly signalled opinion.",
    "If the draft makes no factual claims, return an empty list.",
  ],
  material: (_ctx, input) => [{ label: "DRAFT", text: input.body }],
});
