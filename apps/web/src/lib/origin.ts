import { isUntouchedAi } from "@pubrick/shared";

/**
 * Who wrote the text on a content item — derived, never stored (spec §6).
 *
 * Three of the four badges need nothing but the `origin` columns:
 *
 * - `human` — a human typed the body, and every channel body is theirs too.
 * - `aiAdapted` — a human wrote the body, but at least one channel's text was
 *   written by the model. That combination is what makes the per-channel
 *   `origin` column worth exposing at all.
 * - `ai` — the model drafted the body, and it is still the model's.
 *
 * The fourth, `humanEdited`, needs the AI's own text to compare against, and
 * `GET /api/content/:id` now returns it as `aiVersionBodies` — which is the
 * whole of what changed here. Increment 1 shipped three of four only because
 * the version rows never left the server.
 *
 * **Which rows this badge is allowed to read is a decision, not a detail.**
 * The provenance-lens design's §3 is the authority, and it gives each question
 * its own reference:
 *
 * | Question | Reference |
 * |---|---|
 * | May this be approved? (the gate) | the **first** `ai` row per level |
 * | What does the badge say? | **any** `ai` row |
 * | Which sentences dim? | **all** `ai` rows |
 *
 * So the badge is `bodies.some(b => isUntouchedAi(body, b))` and never the
 * gate's first-row rule. Today there is exactly one `ai` row per level, so the
 * two coincide and the wrong choice would look right — until increment 2b's
 * refine verbs write the second row, at which point the gate's rule would read
 * an accepted refinement as the human's own writing.
 *
 * Everything unknown still resolves to the AI badge. No reference text (an
 * older payload, the LIST endpoint, a version row that was never written) means
 * no evidence of an edit, and no evidence of an edit is not evidence of one:
 * answering `humanEdited` there would over-claim human authorship on a body
 * nobody touched. Under-claiming is the direction `@pubrick/shared`'s
 * provenance functions are written and mutation-tested against, and this
 * follows them.
 */
export type ContentOrigin = "ai" | "human";

export type OriginBadgeKind = "ai" | "aiAdapted" | "human" | "humanEdited";

/**
 * The `ai` version bodies for one item: the master body's, and each
 * adaptation's under its own id. The shape `GET /api/content/:id` returns.
 */
export type AiVersionBodies = {
  item: string[];
  adaptations: Record<string, string[]>;
};

export function deriveOrigin(item: {
  origin: ContentOrigin;
  adaptations: { origin: ContentOrigin }[];
  /**
   * Optional because the LIST endpoint returns neither: its cards can only
   * ever show the three badges increment 1 shipped. Making them required would
   * force the list to invent values it has no basis for, and the fallback here
   * is the safe one.
   */
  body?: string;
  aiVersionBodies?: AiVersionBodies;
}): OriginBadgeKind {
  if (item.origin !== "ai") {
    return item.adaptations.some((a) => a.origin === "ai") ? "aiAdapted" : "human";
  }

  const body = item.body;
  const bodies = item.aiVersionBodies?.item;
  if (body === undefined || bodies === undefined || bodies.length === 0) return "ai";
  // ANY row, per §3 — not the first, and never a concatenation of them:
  // `isUntouchedAi` short-circuits on a sentence-count mismatch, so a joined
  // reference always answers false and would read every AI draft as edited.
  return bodies.some((aiVersion) => isUntouchedAi(body, aiVersion)) ? "ai" : "humanEdited";
}
