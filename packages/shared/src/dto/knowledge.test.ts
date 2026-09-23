import { describe, expect, it } from "vitest";
import { knowledgeImportSchema } from "./knowledge.js";

const brandId = "b4c85667-4c08-4f94-89e0-af5ee4f638af";
const entry = {
  title: "Voice",
  content: "Use a warm tone",
  category: "brand_guidelines",
  tags: ["coffee, roasted", "bulk|B2B"],
} as const;

describe("knowledge bulk import", () => {
  it("preserves an explicit paused state and defaults older clients to active", () => {
    expect(
      knowledgeImportSchema.parse({ brandId, entries: [{ ...entry, isActive: false }, entry] }),
    ).toEqual({
      brandId,
      entries: [
        { ...entry, isActive: false },
        { ...entry, isActive: true },
      ],
    });
  });

  it("rejects invalid activity, tags, and any invalid row in a batch", () => {
    for (const invalid of [
      { ...entry, isActive: "false" },
      { ...entry, tags: ["x".repeat(51)] },
      { ...entry, tags: Array.from({ length: 21 }, () => "x") },
      { ...entry, title: "" },
    ]) {
      expect(knowledgeImportSchema.safeParse({ brandId, entries: [entry, invalid] }).success).toBe(
        false,
      );
    }
  });
});
