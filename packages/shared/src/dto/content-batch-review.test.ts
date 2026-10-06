import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  contentBatchReviewConfirmSchema,
  contentBatchReviewRequestSchema,
  contentBatchReviewResultSchema,
} from "./content-batch-review.js";

describe("bounded explicit saved-version batch review", () => {
  it("requires unique explicit IDs and refuses hidden-page/all selectors", () => {
    const id = randomUUID();
    expect(contentBatchReviewRequestSchema.safeParse({ itemIds: [id] }).success).toBe(true);
    for (const input of [
      { itemIds: [] },
      { itemIds: [id, id] },
      { itemIds: Array.from({ length: 21 }, () => randomUUID()) },
      { itemIds: [id], all: true },
      { status: "draft" },
    ])
      expect(contentBatchReviewRequestSchema.safeParse(input).success).toBe(false);
  });
  it("requires each exact unique reviewed snapshot and an opaque token", () => {
    const row = { id: randomUUID(), fingerprint: "a".repeat(64) };
    expect(
      contentBatchReviewConfirmSchema.safeParse({ token: "opaque", reviewed: [row] }).success,
    ).toBe(true);
    for (const input of [
      { token: "", reviewed: [row] },
      { token: "opaque", reviewed: [] },
      { token: "opaque", reviewed: [row, row] },
      { token: "opaque", reviewed: [{ ...row, fingerprint: "changed" }] },
      { token: "opaque", reviewed: [row], approveFuture: true },
    ])
      expect(contentBatchReviewConfirmSchema.safeParse(input).success).toBe(false);
  });
  it("describes only queued receipts with exact delivery attempts", () => {
    const row = {
      id: randomUUID(),
      status: "queued",
      deliveries: [{ adaptationId: randomUUID(), channelId: randomUUID(), attemptCount: 0 }],
    };
    expect(contentBatchReviewResultSchema.safeParse({ items: [row] }).success).toBe(true);
    expect(
      contentBatchReviewResultSchema.safeParse({ items: [{ ...row, status: "published" }] })
        .success,
    ).toBe(false);
    expect(
      contentBatchReviewResultSchema.safeParse({
        items: [{ ...row, deliveries: [{ ...row.deliveries[0], attemptCount: -1 }] }],
      }).success,
    ).toBe(false);
  });
});
