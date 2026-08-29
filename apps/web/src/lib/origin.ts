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
 * The fourth, `humanEdited`, needs the AI's own text to compare against. The
 * API answers that comparison as `bodyIsAiVerbatim` — a single boolean, on
 * BOTH the item response and every row of the list.
 *
 * **Why the API and not here.** The comparison itself is `allSentencesAi` in
 * `@pubrick/shared`, and it needs the `ai` version rows — their `scope`
 * included, which the response does not carry. The item screen is given the
 * bodies anyway (the lens dims against them), so this function used to run the
 * comparison itself — and the QUEUE could not, because its rows carry no
 * version bodies and shipping the full text of every version to draw a badge
 * would be absurd. The result was a card that read "AI-drafted" for a body the
 * detail screen called "Human-edited" one click later, which is precisely the
 * claim the provenance-lens design's §5 leans on when it ships the lens off by
 * default: *the badge already carries the claim at a glance on every card*. A
 * boolean makes that sentence true.
 *
 * So the formula lives in one place, `ContentRepository`, next to the publish
 * gate's own read of the same table — where the two grains of the question can
 * be read side by side rather than across a process boundary.
 *
 * **Which rows the badge is allowed to read is a decision, not a detail.**
 * There is ONE question — is every sentence of this text still the model's —
 * and two references, per the authorship-per-sentence design's §2:
 *
 * | Question | Reference | Grain |
 * |---|---|---|
 * | May this be approved? (the gate) / what does the badge say? | **all** `ai` rows, and the first `full` row for the deletion clause | the whole text |
 * | Which sentences dim? (the lens) | **all** `ai` rows | one sentence |
 *
 * There used to be a third — "does the body equal ANY `ai` row" — and it is
 * gone because a refine's fragment can never EQUAL a whole body: the moment the
 * model refines a draft, that formula captions the model's own words
 * "Human-edited" while the gate refuses the same draft. Two answers to one
 * question on one screen.
 *
 * **The badge and the lens can still disagree on that screen, and honestly so.**
 * They answer at different grains, and the whole-text grain knows one thing the
 * dimming cannot show: what is NO LONGER there. Delete a sentence and every
 * sentence left is the model's — the lens dims all of them — while the badge
 * reads "Human-edited", which is true, and which the lens legend says out loud
 * rather than leaving the reader to reconcile. The mirror case is a level whose
 * only evidence is a fragment: no `full` row, so the badge takes its fail-safe
 * and reads "AI-drafted" while most sentences stay undimmed. That one is
 * missing evidence rather than a claim, and it is not paperable-over here.
 *
 * Everything unknown still resolves to the AI badge. An older payload with no
 * `bodyIsAiVerbatim` at all means no evidence of an edit, and no evidence of an
 * edit is not evidence of one: answering `humanEdited` there would over-claim
 * human authorship on a body nobody touched. Under-claiming is the direction
 * `@pubrick/shared`'s provenance functions are written and mutation-tested
 * against, and this follows them.
 */
export type ContentOrigin = "ai" | "human";

export type OriginBadgeKind = "ai" | "aiAdapted" | "human" | "humanEdited";

/**
 * The `ai` version bodies for one item: the master body's, and each
 * adaptation's under its own id. The shape `GET /api/content/:id` returns, and
 * the lens's reference text — not the badge's, which is a boolean.
 */
export type AiVersionBodies = {
  item: string[];
  adaptations: Record<string, string[]>;
};

export function deriveOrigin(item: {
  origin: ContentOrigin;
  adaptations: { origin: ContentOrigin }[];
  /**
   * Whether the saved body still matches some `ai` version. Optional only for
   * a payload written before the field existed; both the list and the item
   * response carry it, and its absence falls back to the safe answer.
   */
  bodyIsAiVerbatim?: boolean;
}): OriginBadgeKind {
  if (item.origin !== "ai") {
    return item.adaptations.some((a) => a.origin === "ai") ? "aiAdapted" : "human";
  }
  return item.bodyIsAiVerbatim === false ? "humanEdited" : "ai";
}
