import { describe, expect, it } from "vitest";
import {
  publicationMovesSchema,
  publicationOperationsQuerySchema,
} from "./publication-operations.js";

const id = "b4e00c41-3b95-4fc5-a37a-180866499ce0";
const from = "2030-01-01T00:00:00.000Z";
const to = "2030-01-08T00:00:00.000Z";
describe("publication calendar boundaries", () => {
  it("accepts paired scheduled ranges and a channel selection", () => {
    expect(
      publicationOperationsQuerySchema.parse({ filter: "scheduled", from, to, channelId: id }),
    ).toMatchObject({ from, to, channelId: id });
  });
  it.each([
    { filter: "scheduled", from },
    { filter: "published", from, to },
    { filter: "scheduled", from: to, to: from },
    { filter: "scheduled", from, to: "2030-05-01T00:00:00.000Z" },
  ])("refuses incomplete, non-scheduled or excessive ranges: %o", (query) => {
    expect(publicationOperationsQuerySchema.safeParse(query).success).toBe(false);
  });
  it("bounds move sets and requires the attempt and time fences", () => {
    const move = {
      adaptationId: id,
      expectedScheduledAt: from,
      expectedAttemptCount: 1,
      scheduledAt: to,
    };
    expect(publicationMovesSchema.parse({ moves: [move] }).moves).toEqual([move]);
    expect(publicationMovesSchema.safeParse({ moves: [move, move] }).success).toBe(false);
    expect(publicationMovesSchema.safeParse({ moves: [] }).success).toBe(false);
    expect(
      publicationMovesSchema.safeParse({ moves: [{ ...move, expectedAttemptCount: -1 }] }).success,
    ).toBe(false);
    const { expectedAttemptCount: _, ...missingFence } = move;
    expect(publicationMovesSchema.safeParse({ moves: [missingFence] }).success).toBe(false);
  });
});
