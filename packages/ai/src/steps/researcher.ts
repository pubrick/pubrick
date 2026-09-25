import { z } from "zod";
import { defineStep, type Material } from "./prompt.js";
import { BUILT_IN_ROLE_LINES } from "./role-manifest.js";
import type { RunStepContext, Step } from "./types.js";

/**
 * The plan a post is written from.
 *
 * Only `min` bounds, no `max`: a violation costs a repair call and can fail the
 * whole run, so the schema enforces what the next step genuinely cannot work
 * without — an angle and at least one key point — and leaves length to the
 * model's own limits. (The bodies are different: their length is bounded by what
 * the API can later edit. See the writer.)
 */
export const researchSchema = z.object({
  angle: z.string().min(1),
  keyPoints: z.array(z.string().min(1)).min(1),
  avoid: z.array(z.string().min(1)),
});
export type ResearchOutput = z.infer<typeof researchSchema>;

/**
 * Step 1 — turn the brief into a plan.
 *
 * No web access in this increment, which is why the instructions forbid
 * inventing facts rather than asking for sources: a model told to research with
 * no way to look anything up produces confident invention.
 *
 * The role line used to say "no sources: work from the brief", and a step that
 * can be handed pasted material made both halves of that false — it may have a
 * source, and on a paste-only run there is no brief. It is widened over "the
 * material" rather than over "the source" for the reason the writer's line is:
 * this step runs on every run, and a rule naming a thing that is not there is a
 * rule the model has to guess at. The no-web-access half is unchanged: nothing
 * in this increment fetches anything, which is exactly why the source is
 * attribution rather than verification.
 *
 * "What the audience already knows" lives in `avoid` rather than in a field of
 * its own — it is one of the things the post should not spend words on, and a
 * field the writer would have to be told to treat as a subtraction is the same
 * instruction spread over two places.
 */
export const RESEARCHER: Step<void, ResearchOutput, RunStepContext> = defineStep({
  name: "researcher",
  schema: researchSchema,
  role: BUILT_IN_ROLE_LINES.researcher,
  material: (ctx: RunStepContext) => {
    const blocks: Material[] = [];
    // Each block is pushed only when it has text, so a paste-only run carries no
    // BRIEF label at all and a brief-only run carries no SOURCE. `!= null` is
    // loose on purpose: `undefined` is unreachable through the type but not
    // through a spec that vitest stripped, and a strict check would interpolate
    // the word "undefined" into a labelled block on a paid call.
    //
    // BLANK IS ABSENT TOO, which is the same rule `instructionsFor` applies to
    // an unset brand voice: a labelled but empty block tells the model the
    // person wrote nothing USEFUL rather than that they wrote nothing.
    // `runs.repository.create` already stores `null` for the `""` the compose
    // screen sends unconditionally, so this is the belt behind that boundary and
    // not a second opinion about it — it decides PRESENCE only and never edits
    // the text, so no prompt can differ from the receipt the run screen shows.
    if (ctx.brief != null && ctx.brief.trim() !== "") {
      blocks.push({ label: "BRIEF", text: ctx.brief });
    }
    if (ctx.material != null && ctx.material.trim() !== "") {
      blocks.push({ label: "SOURCE", text: ctx.material });
    }
    if (ctx.knowledge?.length) {
      blocks.push({
        label: "BRAND KNOWLEDGE",
        text: ctx.knowledge
          .map((entry) => `[${entry.category}] ${entry.title}\n${entry.content}`)
          .join("\n\n"),
      });
    }
    if (ctx.relatedNews?.length) {
      blocks.push({
        label: "RELATED FEED EXCERPTS (UNVERIFIED)",
        text: ctx.relatedNews.map((item) => `${item.title}\n${item.summary}`).join("\n\n"),
      });
    }
    // `ctx.sourceUrl` is deliberately absent: attribution, not material.
    return blocks;
  },
});
