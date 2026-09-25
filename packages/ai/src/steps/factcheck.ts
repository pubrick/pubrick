import { CLAIMS_TO_VERIFY_LABEL } from "@pubrick/shared";
import { z } from "zod";
import { defineStep } from "./prompt.js";
import { BUILT_IN_ROLE_LINES } from "./role-manifest.js";
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
      sourceId: z.string().nullable().optional(),
      sourceQuote: z.string().nullable().optional(),
    }),
  ),
});
export type FactcheckOutput = z.infer<typeof factcheckSchema>;

export type FactcheckSource = { id: string; text: string };
export type FactcheckInput = { body: string; sources?: FactcheckSource[] };

const NOTE_ID = /^note:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEWS_ID = /^news:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUOTE_LIMIT = 320;
const NOTE_LIMIT = 3000;
const MATERIAL_LIMIT = 6000;

/** The same bounded snapshots are sent to the model and used for validation. */
export function factcheckSources(
  knowledge: readonly { id?: string; content: string }[] | undefined,
  material: string | null | undefined,
  relatedNews: readonly { id: string; title: string; summary: string }[] | undefined = [],
): FactcheckSource[] {
  const sources: FactcheckSource[] = [];
  for (const entry of (knowledge ?? []).slice(0, 5)) {
    const id = `note:${entry.id ?? ""}`;
    if (NOTE_ID.test(id) && entry.content) {
      sources.push({ id, text: entry.content.slice(0, NOTE_LIMIT) });
    }
  }
  if (material) sources.push({ id: "material", text: material.slice(0, MATERIAL_LIMIT) });
  for (const item of relatedNews.slice(0, 2)) {
    const id = `news:${item.id}`;
    if (NEWS_ID.test(id)) sources.push({ id, text: `${item.title}\n${item.summary}` });
  }
  return sources;
}

function normalized(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Never let a model-created citation become evidence without an exact excerpt. */
export function validateFactcheckSources(
  output: FactcheckOutput,
  sources: readonly FactcheckSource[],
): FactcheckOutput {
  const corpus = new Map(sources.map((source) => [source.id, normalized(source.text)]));
  return {
    claims: output.claims.map((claim) => {
      if (claim.sourceId === undefined && claim.sourceQuote === undefined) return claim;
      const quote = typeof claim.sourceQuote === "string" ? normalized(claim.sourceQuote) : "";
      if (
        typeof claim.sourceId === "string" &&
        quote.length > 0 &&
        quote.length <= QUOTE_LIMIT &&
        corpus.get(claim.sourceId)?.includes(quote)
      ) {
        return { ...claim, sourceQuote: quote };
      }
      return { ...claim, sourceId: null, sourceQuote: null };
    }),
  };
}

/**
 * Step 4 — list the claims, check none of them.
 *
 * This step **verifies nothing**: it reads the draft and
 * lists what a person would have to confirm before publishing. The list rides
 * with the draft into the review queue under the heading
 * `CLAIMS_TO_VERIFY_LABEL`, and no string anywhere — instructions, schema, API
 * or UI — may suggest a check happened. A run started from a pasted story
 * gives the step supplied material, but a source excerpt is attribution, not
 * independent verification. The human still checks every factual claim.
 */
const factcheckStep = defineStep<FactcheckInput, FactcheckOutput>({
  name: "factcheck",
  schema: factcheckSchema,
  role: BUILT_IN_ROLE_LINES.factcheck,
  material: (_ctx, input) => [
    { label: "DRAFT", text: input.body },
    ...(input.sources ?? []).map((source) => ({ label: `SOURCE ${source.id}`, text: source.text })),
  ],
});

export const FACTCHECK: Step<FactcheckInput, FactcheckOutput> = {
  name: factcheckStep.name,
  schema: factcheckStep.schema,
  run: async (ctx, input) =>
    validateFactcheckSources(await factcheckStep.run(ctx, input), input.sources ?? []),
};
