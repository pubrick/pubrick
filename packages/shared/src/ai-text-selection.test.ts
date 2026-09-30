import { describe, expect, it } from "vitest";
import {
  AiTextSelectionChangedError,
  aiTextSettingsUpdateSchema,
  legacyTextIdentity,
} from "./ai-text-selection.js";

describe("legacy text identity", () => {
  it("ignores image and embedding charges when identifying text history", () => {
    expect(
      legacyTextIdentity(
        [
          { provider: "google", modelId: "image-only", step: "cover" },
          { provider: "google", modelId: "embedding-only", step: "knowledge" },
          { provider: "openai", modelId: "pinned-text", step: "writer" },
        ],
        true,
        0,
      ),
    ).toEqual({ provider: "openai", modelId: "pinned-text" });
  });
  it.each([
    [[], true, 0],
    [[], false, 1],
    [[{ provider: "google" as const, modelId: "image", step: "cover" }], true, 0],
    [
      [
        { provider: "google" as const, modelId: "one", step: "writer" },
        { provider: "openai" as const, modelId: "two", step: "editor" },
      ],
      true,
      0,
    ],
  ])(
    "refuses unknown or mixed provenance without fabricating a selection",
    (rows, checkpoints, lost) => {
      expect(() => legacyTextIdentity(rows, checkpoints, lost)).toThrow(
        AiTextSelectionChangedError,
      );
    },
  );
  it("permits a fresh unstarted run to use the migrated workspace default", () => {
    expect(legacyTextIdentity([], false, 0)).toBeNull();
  });
  it("requires a revision and rejects an empty explicit model", () => {
    expect(
      aiTextSettingsUpdateSchema.safeParse({ provider: "openai", model: " ", expectedRevision: 1 })
        .success,
    ).toBe(false);
    expect(aiTextSettingsUpdateSchema.safeParse({ provider: "openai", model: null }).success).toBe(
      false,
    );
  });
});

it("refuses unknown historical ledger loss", () => {
  expect(() => legacyTextIdentity([], false, null)).toThrow(AiTextSelectionChangedError);
});
