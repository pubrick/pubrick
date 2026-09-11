import { MAX_BODY_LENGTH } from "@pubrick/shared";
import { z } from "zod";
import { defineStep, type Material } from "./prompt.js";
import type { ResearchOutput } from "./researcher.js";
import type { RunStepContext, Step } from "./types.js";

/**
 * The master draft.
 *
 * `MAX_BODY_LENGTH` is not decoration: it bounds `contentCreateSchema` and
 * `contentUpdateSchema`, so a longer body would be written to `content_items`
 * by the run and then be un-editable through the API forever — the same defect
 * the adapter's platform limit exists to prevent, one table over.
 */
export const draftSchema = z.object({
  body: z.string().min(1).max(MAX_BODY_LENGTH),
});
export type DraftOutput = z.infer<typeof draftSchema>;

export type WriterInput = { research: ResearchOutput };

/** The plan, formatted for the model as material rather than as instructions. */
export function planMaterial(research: ResearchOutput): string {
  return [
    `Angle: ${research.angle}`,
    "",
    "Key points:",
    ...research.keyPoints.map((point) => `- ${point}`),
    ...(research.avoid.length === 0
      ? []
      : ["", "Avoid:", ...research.avoid.map((item) => `- ${item}`)]),
  ].join("\n");
}

/**
 * Step 2 — write the master draft the channels are adapted from.
 *
 * TWO ROLE LINES ANSWER THE MATERIAL, and they are separate rules.
 *
 * The third line used to read "add nothing the BRIEF or the plan does not
 * support", which told this step to ignore the pasted article it had just been
 * handed — and on a paste-only run, where the brief is null, to support nothing
 * at all. Widened, not deleted: the rule against invention is the point of it.
 *
 * The fourth is added by this increment and is the only place anything in this
 * product says not to reproduce someone else's text. It is phrased over "the
 * material" rather than over "the source" deliberately: this step runs on EVERY
 * run including brief-only ones, and a role line naming a source that is not
 * there is a rule the model has to guess at.
 *
 * It is an instruction, never a guarantee. Nothing checks the draft against the
 * material, `steps.test.ts` can pin this prompt and never the output, and the
 * gate that follows answers who TYPED a sentence rather than where the sentence
 * came from before that — which is why no string in this product claims the
 * text is original or that anything verified it.
 */
export const WRITER: Step<WriterInput, DraftOutput, RunStepContext> = defineStep({
  name: "writer",
  schema: draftSchema,
  role: [
    "You write the master draft of a social post, working from a brief and a plan someone else made.",
    "Write the post itself: no title, no preamble, no explanation of what you wrote, no hashtags unless the brief asks for them.",
    "Make every point in the plan, in its order, and add nothing the material or the plan does not support.",
    "Write from the material in your own words: take what it says, not how it says it, and do not reproduce it at length.",
    `The post must be at most ${MAX_BODY_LENGTH} characters. It is adapted per channel afterwards, so write it for a reader, not for a platform.`,
  ],
  material: (ctx: RunStepContext, input) => {
    // The person's words first, in whichever forms they exist — see the
    // researcher for why the two predicates are loose and why blank counts as
    // absent — and then the plan.
    const blocks: Material[] = [];
    if (ctx.brief != null && ctx.brief.trim() !== "") {
      blocks.push({ label: "BRIEF", text: ctx.brief });
    }
    if (ctx.material != null && ctx.material.trim() !== "") {
      blocks.push({ label: "SOURCE", text: ctx.material });
    }
    // Not re-parsed here: a resumed run reads this from a jsonb checkpoint, and
    // the place to validate that is the run, which can classify the failure. A
    // ZodError thrown from inside a step would reach pg-boss unclassified and be
    // retried until the attempts ran out.
    blocks.push({ label: "PLAN", text: planMaterial(input.research) });
    return blocks;
  },
});
