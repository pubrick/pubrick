import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "@pubrick/ai";

export type FeedbackArticle = {
  title: string;
  summary: string;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
};
export type FeedbackSignals = {
  relevant: FeedbackArticle[];
  irrelevant: FeedbackArticle[];
};

const MAX_ADJUSTMENT = 0.2;
const SEMANTIC_FLOOR = 0.65;
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

function usableVector(article: FeedbackArticle): number[] | null {
  const vector = article.embedding;
  if (
    !vector ||
    article.embeddingDimensions !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
    vector.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
    !vector.every(Number.isFinite)
  ) {
    return null;
  }
  return vector;
}

/** Return null for old or incompatible vectors so only those use headline matching. */
export function semanticSimilarity(
  candidate: FeedbackArticle,
  reference: FeedbackArticle,
): number | null {
  if (!candidate.embeddingModel || candidate.embeddingModel !== reference.embeddingModel)
    return null;
  const a = usableVector(candidate);
  const b = usableVector(reference);
  if (!a || !b) return null;
  let dot = 0;
  let aLength = 0;
  let bLength = 0;
  for (let index = 0; index < KNOWLEDGE_EMBEDDING_DIMENSIONS; index += 1) {
    const aValue = a[index] ?? 0;
    const bValue = b[index] ?? 0;
    dot += aValue * bValue;
    aLength += aValue * aValue;
    bLength += bValue * bValue;
  }
  if (!aLength || !bLength) return null;
  const cosine = dot / Math.sqrt(aLength * bLength);
  if (!Number.isFinite(cosine)) return null;
  // Weak or unrelated semantic matches should not train editorial preference.
  return Math.max(0, Math.min(1, (cosine - SEMANTIC_FLOOR) / (1 - SEMANTIC_FLOOR)));
}

/** The model verdict stays stored separately; equal opposing signals cancel. */
export function feedbackAdjustment(candidate: FeedbackArticle, signals: FeedbackSignals): number {
  const strongest = (articles: FeedbackArticle[]) =>
    articles.reduce(
      (best, article) =>
        Math.max(
          best,
          semanticSimilarity(candidate, article) ?? 0,
          headlineSimilarity(candidate, article),
        ),
      0,
    );
  const delta = MAX_ADJUSTMENT * (strongest(signals.relevant) - strongest(signals.irrelevant));
  return Math.round(delta * 10_000) / 10_000;
}
