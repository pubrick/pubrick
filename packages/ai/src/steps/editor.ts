import { MAX_BODY_LENGTH } from "@pubrick/shared";
import { z } from "zod";
import { defineStep, type Material } from "./prompt.js";
import type { ResearchOutput } from "./researcher.js";
import type { RunStepContext, Step } from "./types.js";
import { planMaterial } from "./writer.js";

/**
 * The edited draft plus what changed.
 *
 * `changes` may be empty — an editor that changed nothing is a real outcome, and
 * a schema that forbade it would push the model into inventing an edit to
 * satisfy the shape. The strings are unbounded for the same reason the
 * researcher's are: failing a whole run over a verbose change note would cost
 * more than the note is worth. `body` is bounded, because `MAX_BODY_LENGTH` is
 * what the API can later edit.
 */
export const editSchema = z.object({
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  changes: z.array(z.string().min(1)),
});
export type EditOutput = z.infer<typeof editSchema>;

export type EditorInput = { research: ResearchOutput; body: string };

/**
 * Step 3 — tighten the draft to the brand voice.
 *
 * It gets the plan as well as the draft so that the "avoid" list is still in
 * force at the edit; an editor holding only the draft cannot tell a deliberate
 * omission from a missing point.
 */
export const EDITOR: Step<EditorInput, EditOutput, RunStepContext> = defineStep({
  name: "editor",
  schema: editSchema,
  role: [
    "You edit a draft post into the brand's voice. You are the last person to touch it before a human reads it.",
    "Cut what does not earn its place, fix what is limp or generic, and keep the writer's meaning. Do not add facts, numbers, names or claims that are not already in the draft.",
    `The edited post must be at most ${MAX_BODY_LENGTH} characters.`,
    "Produce:",
    "- body: the edited post, complete, ready to read.",
    "- changes: what you changed, one short plain-language line each, for the human who approves this. If you changed nothing, return an empty list rather than inventing an edit.",
  ],
  material: (ctx: RunStepContext, input) => {
    // The editor keeps the person's ask in force at the edit, so it gets the
    // material for the same reason it gets the brief — see the researcher for
    // why the two predicates are loose.
    const blocks: Material[] = [];
    if (ctx.brief != null) blocks.push({ label: "BRIEF", text: ctx.brief });
    if (ctx.material != null) blocks.push({ label: "SOURCE", text: ctx.material });
    blocks.push({ label: "PLAN", text: planMaterial(input.research) });
    blocks.push({ label: "DRAFT", text: input.body });
    return blocks;
  },
});
