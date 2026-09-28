import { describe, expect, it } from "vitest";
import { publicationOperationsQuerySchema } from "./publication-operations.js";

describe("publication operations query", () => {
  it("defaults to an attention page and bounds its size", () => {
    expect(publicationOperationsQuerySchema.parse({})).toEqual({
      filter: "needs_attention",
      limit: 30,
    });
    for (const limit of [0, 101, "NaN", 1.2]) {
      expect(publicationOperationsQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    expect(publicationOperationsQuerySchema.safeParse({ filter: "retry" }).success).toBe(false);
  });
});
