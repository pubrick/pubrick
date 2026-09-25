import { MAX_BODY_LENGTH, normalizeNewlines } from "@pubrick/shared";
import { z } from "zod";
import { defineStep, type Material } from "./prompt.js";
import type { RunStepContext, Step } from "./types.js";

/** Optional editorial rewrite of an expert article, with no SEO metrics claim. */
export const seoPolishSchema = z.object({
  body: z.string().overwrite(normalizeNewlines).min(1).max(MAX_BODY_LENGTH),
});
export type SeoPolishOutput = z.infer<typeof seoPolishSchema>;
export type SeoPolishInput = { body: string; keywords: string[] };

export const SEO_POLISH: Step<SeoPolishInput, SeoPolishOutput, RunStepContext> = defineStep({
  name: "seo_polish",
  schema: seoPolishSchema,
  role: [
    "You improve the discoverability and readability of a draft expert article without changing its substance.",
    "Use supplied editorial keywords naturally only where relevant. Never force repetition or claim search volume, rankings, traffic, or optimization results.",
    "Keep the article's thesis, supported facts, caveats, section structure, and practical conclusion. Improve heading wording where a relevant keyword fits naturally, without changing the sections or their order.",
    "If it fits the opening naturally, use the first supplied keyword in the first paragraph. Omit any keyword that does not fit honestly. Never add facts, numbers, citations, links, claims, or HTML.",
    "Return the complete article body as plain text with headings on their own lines.",
    `The body must be at most ${MAX_BODY_LENGTH} characters.`,
  ],
  material: (_ctx: RunStepContext, input): Material[] => [
    { label: "EDITORIAL KEYWORDS", text: input.keywords.join("\n") },
    { label: "DRAFT", text: input.body },
  ],
});
