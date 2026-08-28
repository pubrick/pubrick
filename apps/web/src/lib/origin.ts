/**
 * Who wrote the text on a content item — derived, never stored (spec §6).
 *
 * `content_items.origin` and `adaptations.origin` are the only inputs any
 * endpoint exposes, and that is enough for three of the four badges the spec
 * names:
 *
 * - `human` — a human typed the body, and every channel body is theirs too.
 * - `aiAdapted` — a human wrote the body, but at least one channel's text was
 *   written by the model. That combination is what makes the per-channel
 *   `origin` column worth exposing at all.
 * - `ai` — the model drafted the body.
 *
 * The fourth, `human-edited` (spec §6: `origin = 'ai'` and the body no longer
 * matching the first AI version), is NOT derivable here. It needs the text of
 * that first `content_versions` row, which no endpoint returns — the API reads
 * it only internally, to decide whether an untouched AI draft may be approved.
 * So an AI draft a human has since rewritten still reads "AI-drafted".
 *
 * That is the direction provenance is required to fail in: it under-claims the
 * human's authorship and never over-claims it, which is the same invariant
 * `@pubrick/shared`'s provenance functions are written and mutation-tested
 * against. The alternative — inventing a field, or guessing from `updatedAt` —
 * would over-claim on some input, and over-claiming is the failure this whole
 * feature exists to prevent.
 */
export type ContentOrigin = "ai" | "human";

export type OriginBadgeKind = "ai" | "aiAdapted" | "human";

export function deriveOrigin(item: {
  origin: ContentOrigin;
  adaptations: { origin: ContentOrigin }[];
}): OriginBadgeKind {
  if (item.origin === "ai") return "ai";
  return item.adaptations.some((a) => a.origin === "ai") ? "aiAdapted" : "human";
}
