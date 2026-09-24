/**
 * A deliberately conservative local substitute for semantic similarity.
 * News has no stored embeddings yet, so editor feedback can only nudge a new
 * score when the headlines share several distinctive words.
 */
export type FeedbackArticle = { title: string; summary: string };
export type FeedbackSignals = {
  relevant: FeedbackArticle[];
  irrelevant: FeedbackArticle[];
};

const MAX_ADJUSTMENT = 0.2;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

function words(text: string): Set<string> {
  const result = new Set<string>();
  for (const part of segmenter.segment(text.normalize("NFKC").toLowerCase())) {
    if (!part.isWordLike) continue;
    const word = part.segment;
    // Very short words, years, and numbers mostly match unrelated headlines.
    if (word.length < 4 || /^\p{N}+$/u.test(word)) continue;
    result.add(word);
  }
  return result;
}

function overlap(a: Set<string>, b: Set<string>): { count: number; dice: number } {
  if (!a.size || !b.size) return { count: 0, dice: 0 };
  let count = 0;
  for (const word of a) if (b.has(word)) count += 1;
  return { count, dice: (2 * count) / (a.size + b.size) };
}

export function headlineSimilarity(candidate: FeedbackArticle, reference: FeedbackArticle): number {
  const title = overlap(words(candidate.title), words(reference.title));
  // One shared company or category name is too weak to infer editorial taste.
  if (title.count < 2 || title.dice < 0.6) return 0;
  const candidateSummary = words(candidate.summary.slice(0, 500));
  const referenceSummary = words(reference.summary.slice(0, 500));
  if (!candidateSummary.size || !referenceSummary.size) return title.dice;
  const summary = overlap(candidateSummary, referenceSummary);
  return 0.8 * title.dice + 0.2 * summary.dice;
}

/** The model verdict stays stored separately; equal opposing signals cancel. */
export function feedbackAdjustment(candidate: FeedbackArticle, signals: FeedbackSignals): number {
  const strongest = (articles: FeedbackArticle[]) =>
    articles.reduce((best, article) => Math.max(best, headlineSimilarity(candidate, article)), 0);
  const delta = MAX_ADJUSTMENT * (strongest(signals.relevant) - strongest(signals.irrelevant));
  return Math.round(delta * 10_000) / 10_000;
}
