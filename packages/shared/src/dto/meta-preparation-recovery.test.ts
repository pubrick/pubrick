import { describe, expect, it } from "vitest";
import {
  META_PREPARATIONS_PAGE_SIZE,
  metaPreparationDiscardSchema,
  metaPreparationsPageSchema,
} from "./meta-preparation-recovery.js";

const stage = {
  stageId: "ebad2852-cb20-44d4-921e-834a1bfe149b",
  adaptationId: "a86fbef4-bfad-4d88-bd1c-e0798b16353c",
  platform: "threads",
  phase: "preparation_unknown",
  attempt: 1,
  inputHash: "a".repeat(64),
  containerId: null,
  channelName: "Studio",
  reason: "preparation_receipt_lost",
  recoverable: true,
  createdAt: "2026-10-07T10:00:00.000Z",
};
describe("nonpublic Meta preparation recovery contract", () => {
  it("requires the exact displayed attempt/hash and an explicit quota acknowledgment", () => {
    const input = {
      expectedAttempt: 1,
      expectedInputHash: stage.inputHash,
      acknowledgeNonpublicPreparation: true,
    };
    expect(metaPreparationDiscardSchema.parse(input)).toEqual(input);
    for (const patch of [
      { expectedAttempt: 0 },
      { expectedInputHash: "wrong" },
      { acknowledgeNonpublicPreparation: false },
      { acknowledgeNonpublicPreparation: undefined },
      { approve: true },
    ])
      expect(metaPreparationDiscardSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it("never admits credentials, capability URLs or publication identities in a public snapshot", () => {
    for (const secret of [
      { accessToken: "secret" },
      { frozenInput: { text: "private body" } },
      { externalUrl: "https://fixture.example.com/post" },
      { finalPublicationId: stage.stageId },
    ])
      expect(
        metaPreparationsPageSchema.safeParse({
          stages: [{ ...stage, ...secret }],
          nextCursor: null,
        }).success,
      ).toBe(false);
  });
  it("admits actual numeric preparation IDs and closed progress/reason values", () => {
    expect(
      metaPreparationsPageSchema.parse({
        stages: [
          { ...stage, phase: "waiting", containerId: "123", reason: null, recoverable: false },
        ],
        nextCursor: stage.stageId,
      }).stages[0]?.containerId,
    ).toBe("123");
    for (const patch of [
      { containerId: "https://fixture.example.com/container" },
      { phase: "ready" },
      { reason: "provider prose" },
    ])
      expect(
        metaPreparationsPageSchema.safeParse({ stages: [{ ...stage, ...patch }], nextCursor: null })
          .success,
      ).toBe(false);
  });
  it("bounds each history page and does not pretend the first page is complete", () => {
    expect(
      metaPreparationsPageSchema.safeParse({
        stages: Array.from({ length: META_PREPARATIONS_PAGE_SIZE + 1 }, () => stage),
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      metaPreparationsPageSchema.parse({ stages: [stage], nextCursor: stage.stageId }).nextCursor,
    ).toBe(stage.stageId);
  });
});
