import { feedbackAdjustment, headlineSimilarity, semanticSimilarity } from "@pubrick/ai";
import { describe, expect, it } from "vitest";

const candidate = {
  title: "Battery recycling rules for European manufacturers",
  summary: "The new recycling regulation changes how factories collect batteries.",
};
const similar = {
  title: "European manufacturers face battery recycling rules",
  summary: "Factories must change battery collection under recycling regulation.",
};
const unrelated = {
  title: "Coffee roasters announce cafe equipment sale",
  summary: "A seasonal promotion for espresso grinders.",
};
const vector = (first: number, second: number) => [first, second, ...Array(766).fill(0)];
const embedded = (article: typeof candidate, first: number, second: number) => ({
  ...article,
  embedding: vector(first, second),
  embeddingModel: "gemini-embedding-001",
  embeddingDimensions: 768,
});

describe("headline feedback adjustment", () => {
  it("requires several shared headline words and ignores unrelated feedback", () => {
    expect(headlineSimilarity(candidate, similar)).toBeGreaterThan(0.6);
    expect(headlineSimilarity(candidate, unrelated)).toBe(0);
    expect(
      headlineSimilarity(candidate, {
        title: "Battery makers report annual earnings",
        summary: "This is a different story about business results.",
      }),
    ).toBe(0);
    expect(feedbackAdjustment(candidate, { relevant: [unrelated], irrelevant: [] })).toBe(0);
  });

  it("raises or lowers similar news by at most 0.2", () => {
    const positive = feedbackAdjustment(candidate, {
      relevant: [similar],
      irrelevant: [],
    });
    const negative = feedbackAdjustment(candidate, {
      relevant: [],
      irrelevant: [similar],
    });
    expect(positive).toBeGreaterThan(0);
    expect(positive).toBeLessThanOrEqual(0.2);
    expect(negative).toBeLessThan(0);
    expect(negative).toBeGreaterThanOrEqual(-0.2);
    expect(feedbackAdjustment(candidate, { relevant: [candidate], irrelevant: [] })).toBe(0.2);
    expect(feedbackAdjustment(candidate, { relevant: [], irrelevant: [candidate] })).toBe(-0.2);
  });

  it("uses the strongest match on each side so opposing identical signals cancel", () => {
    expect(
      feedbackAdjustment(candidate, {
        relevant: [unrelated, similar],
        irrelevant: [similar],
      }),
    ).toBe(0);
  });

  it("segments Cyrillic headlines without an English-only word list", () => {
    expect(
      headlineSimilarity(
        { title: "Новые правила маркировки товаров", summary: "" },
        { title: "Правила маркировки товаров опубликованы", summary: "" },
      ),
    ).toBeGreaterThan(0.6);
  });

  it("recognizes a paraphrase using a comparable semantic vector", () => {
    const paraphrase = embedded(unrelated, 1, 0);
    const semanticCandidate = embedded(candidate, 1, 0);
    expect(headlineSimilarity(semanticCandidate, paraphrase)).toBe(0);
    expect(semanticSimilarity(semanticCandidate, paraphrase)).toBe(1);
    expect(feedbackAdjustment(semanticCandidate, { relevant: [paraphrase], irrelevant: [] })).toBe(
      0.2,
    );
  });

  it("balances the strongest positive and negative semantic examples", () => {
    const semanticCandidate = embedded(candidate, 1, 0);
    const opposite = embedded(unrelated, -1, 0);
    expect(
      feedbackAdjustment(semanticCandidate, {
        relevant: [opposite],
        irrelevant: [semanticCandidate],
      }),
    ).toBe(-0.2);
    expect(
      feedbackAdjustment(semanticCandidate, {
        relevant: [semanticCandidate],
        irrelevant: [semanticCandidate],
      }),
    ).toBe(0);
  });

  it("preserves a strong headline match when comparable vectors are weak", () => {
    const semanticCandidate = embedded(candidate, 1, 0);
    const weakVectorReference = embedded(similar, 0, 1);
    expect(semanticSimilarity(semanticCandidate, weakVectorReference)).toBe(0);
    expect(
      feedbackAdjustment(semanticCandidate, {
        relevant: [weakVectorReference],
        irrelevant: [],
      }),
    ).toBeGreaterThan(0);
  });

  it("uses lexical matching for old, incompatible, zero, and malformed vectors", () => {
    const semanticCandidate = embedded(candidate, 1, 0);
    expect(semanticSimilarity(semanticCandidate, { ...similar, embedding: null })).toBeNull();
    expect(
      semanticSimilarity(semanticCandidate, {
        ...embedded(similar, 1, 0),
        embeddingModel: "other-model",
      }),
    ).toBeNull();
    expect(semanticSimilarity(semanticCandidate, embedded(similar, 0, 0))).toBeNull();
    expect(
      semanticSimilarity(semanticCandidate, {
        ...embedded(similar, 1, 0),
        embedding: [1, Number.NaN],
      }),
    ).toBeNull();
    expect(
      feedbackAdjustment(semanticCandidate, { relevant: [similar], irrelevant: [] }),
    ).toBeGreaterThan(0);
  });
});
