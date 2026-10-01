import { describe, expect, it } from "vitest";
import { decodeContentCursor, encodeContentCursor } from "./content.js";
import {
  decodePublicContentCursorV2,
  encodePublicContentCursorV2,
  idempotencyKeySchema,
  PAID_GENERATION_CONSENT_VERSION,
  publicDraftCreateSchema,
  publicRunCreateSchema,
  publicRunStatusSchema,
} from "./public-write.js";

const id = "00000000-0000-4000-8000-000000000001";
describe("explicit public write contracts", () => {
  it("rejects caller-owned publication, provenance and provider authority", () => {
    const draft = { brandId: id, channelIds: [id], body: "Imported text" };
    expect(publicDraftCreateSchema.safeParse(draft).success).toBe(true);
    for (const field of ["status", "origin", "firstOpenedAt", "provider", "requiresImportedReview"])
      expect(publicDraftCreateSchema.safeParse({ ...draft, [field]: "approved" }).success).toBe(
        false,
      );
  });
  it("requires explicit versioned paid consent and retains domain refinements", () => {
    const run = {
      brandId: id,
      channelIds: [id],
      brief: "Write a draft",
      allowPaidGeneration: true,
      consentVersion: PAID_GENERATION_CONSENT_VERSION,
    };
    expect(publicRunCreateSchema.safeParse(run).success).toBe(true);
    for (const patch of [
      { allowPaidGeneration: false },
      { consentVersion: "future" },
      { provider: "google" },
      { brief: "", material: "" },
    ])
      expect(publicRunCreateSchema.safeParse({ ...run, ...patch }).success).toBe(false);
  });
  it("separates cursor audiences without altering legacy bytes", () => {
    const cursor = { id, createdAt: "2026-10-01T12:00:00.123456Z" };
    const v1 = encodeContentCursor(cursor),
      v2 = encodePublicContentCursorV2(cursor);
    expect(decodeContentCursor(v1)).toEqual(cursor);
    expect(decodePublicContentCursorV2(v2)).toEqual(cursor);
    expect(decodeContentCursor(v2)).toBeNull();
    expect(decodePublicContentCursorV2(v1)).toBeNull();
  });
  it("bounds replay keys and never defaults unknown cost to zero", () => {
    for (const value of ["short", "a".repeat(129), "space key", "abcdefgh\n", "🔑abcdefgh"])
      expect(idempotencyKeySchema.safeParse(value).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("client.operation-1").success).toBe(true);
    const result = {
      id,
      status: "failed",
      contentItemId: null,
      error: "generation_failed",
      cost: { status: "unknown" },
    };
    expect(publicRunStatusSchema.parse(result).cost).toEqual({ status: "unknown" });
    expect(publicRunStatusSchema.safeParse({ ...result, cost: { status: "known" } }).success).toBe(
      false,
    );
  });
});
