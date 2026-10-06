import { describe, expect, it } from "vitest";
import { adaptationUpdateSchema, contentUpdateSchema, MAX_CHANNEL_BODY_LENGTH } from "./content.js";

describe("optional saved-body expectations", () => {
  it("retains both expectations for plain master editing", () => {
    const patch = {
      body: "New text.",
      expectedBody: "Saved text.",
      expectedBodyRevision: 2,
    };
    expect(contentUpdateSchema.parse(patch)).toEqual(patch);
  });

  it("preserves legacy plain-text patches and either available master expectation", () => {
    for (const patch of [
      { body: "New text." },
      { body: "New text.", expectedBody: "Saved text." },
      { body: "New text.", expectedBodyRevision: 2 },
    ]) {
      expect(contentUpdateSchema.parse(patch)).toEqual(patch);
    }
  });

  it("retains the exact raw channel baseline rather than normalizing or stripping it", () => {
    const patch = { body: "New text.", expectedBody: "Saved text.\r\n\r\n#news" };
    expect(adaptationUpdateSchema.parse(patch)).toEqual(patch);
  });

  it("distinguishes an inherited body from an omitted legacy expectation", () => {
    for (const patch of [
      { body: "New text.", expectedBody: null },
      { body: null, expectedBody: "Saved text.\n\n#news" },
      { body: null },
    ]) {
      expect(adaptationUpdateSchema.parse(patch)).toEqual(patch);
    }
  });

  it("bounds raw expectations by the stored channel body limit", () => {
    expect(
      adaptationUpdateSchema.safeParse({
        body: "New text.",
        expectedBody: "x".repeat(MAX_CHANNEL_BODY_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      adaptationUpdateSchema.safeParse({
        body: "New text.",
        expectedBody: "x".repeat(MAX_CHANNEL_BODY_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("does not treat an expectation as a change to save", () => {
    expect(adaptationUpdateSchema.safeParse({ expectedBody: null }).success).toBe(false);
    expect(contentUpdateSchema.safeParse({ expectedBody: "Saved text." }).success).toBe(false);
  });
});
