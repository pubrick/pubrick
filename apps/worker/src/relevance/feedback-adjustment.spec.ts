import { describe, expect, it } from "vitest";
import { feedbackAdjustment, headlineSimilarity } from "./feedback-adjustment";

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
});
