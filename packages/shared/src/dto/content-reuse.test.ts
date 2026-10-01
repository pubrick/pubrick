import { describe, expect, it } from "vitest";
import { CONTENT_ORIGINS, CONTENT_STATUSES } from "./content.js";
import {
  CONTENT_REUSE_DIGEST_VERSION,
  CONTENT_REUSE_ELIGIBLE_STATUSES,
  CONTENT_REUSE_HASH_VERSION,
  CONTENT_REUSE_OPERATIONS,
  CONTENT_REUSE_TARGET_KINDS,
  contentReuseActorIdSchema,
  contentReuseAttributionSchema,
  contentReuseCreateSchema,
  contentReuseDigestSchema,
  contentReuseMaterialSchema,
  contentReuseResultSchema,
  contentReuseRetrySchema,
  contentReuseSourceDigestPayloadSchema,
  contentReuseSourcePreviewSchema,
  MAX_CONTENT_REUSE_OPERATIONS,
} from "./content-reuse.js";
import { API_ERROR_CODES } from "./errors.js";
import { PAID_GENERATION_CONSENT_VERSION } from "./public-write.js";
import {
  CONTENT_TYPES,
  MAX_BRIEF_LENGTH,
  MAX_SOURCE_TEXT_LENGTH,
  runCreateSchema,
} from "./runs.js";

const id = "00000000-0000-4000-8000-000000000001";
const consent = { allowPaidGeneration: true, consentVersion: PAID_GENERATION_CONSENT_VERSION };
const request = {
  expectedSourceRevision: 0,
  expectedSourceDigest: "a".repeat(64),
  contentType: "social_post",
  channelIds: [id],
  ...consent,
};
const source = {
  id,
  brandId: id,
  title: null,
  bodyRevision: 0,
  material: "Saved source",
  status: "draft",
  origin: "external",
  digest: "a".repeat(64),
};
const digestPayload = {
  version: CONTENT_REUSE_DIGEST_VERSION,
  contentId: id,
  brandId: id,
  title: null,
  bodyRevision: 0,
  material: "Saved source",
};

describe("session content reuse contracts", () => {
  it("accepts the zero revision default and round trips literal consent", () => {
    expect(contentReuseCreateSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
    for (const revision of [-1, 0.5, "0", null]) {
      expect(
        contentReuseCreateSchema.safeParse({ ...request, expectedSourceRevision: revision })
          .success,
      ).toBe(false);
    }
    for (const bad of [
      { allowPaidGeneration: false },
      { allowPaidGeneration: undefined },
      { consentVersion: "future" },
      { consentVersion: undefined },
    ]) {
      expect(contentReuseCreateSchema.safeParse({ ...request, ...bad }).success).toBe(false);
    }
  });
  it("uses existing title and instruction semantics including bounds and NUL refusal", () => {
    for (const patch of [
      { title: "x".repeat(300) },
      { brief: "x".repeat(MAX_BRIEF_LENGTH) },
      { title: "", brief: "" },
      { title: "a\r\nb", brief: "a\r\nb" },
    ]) {
      expect(contentReuseCreateSchema.parse({ ...request, ...patch })).toEqual({
        ...request,
        ...patch,
      });
    }
    for (const patch of [
      { title: "x".repeat(301) },
      { brief: "x".repeat(MAX_BRIEF_LENGTH + 1) },
      { title: "a\0b" },
      { brief: "a\0b" },
    ]) {
      expect(contentReuseCreateSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
  });
  it("requires an explicit existing format and unique 1–20 UUID channels", () => {
    for (const contentType of CONTENT_TYPES)
      expect(contentReuseCreateSchema.safeParse({ ...request, contentType }).success).toBe(true);
    const twenty = Array.from(
      { length: 20 },
      (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
    );
    expect(contentReuseCreateSchema.parse({ ...request, channelIds: twenty }).channelIds).toEqual(
      twenty,
    );
    for (const patch of [
      { contentType: undefined },
      { contentType: "invented" },
      { channelIds: [] },
      { channelIds: [id, id] },
      { channelIds: [...twenty, "00000000-0000-4000-8000-000000000021"] },
      { channelIds: ["invalid"] },
    ]) {
      expect(contentReuseCreateSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
  });
  it("refuses all caller-owned source, provenance, media, provider and delivery overrides", () => {
    for (const field of [
      "brandId",
      "material",
      "sourceUrl",
      "actorId",
      "origin",
      "provider",
      "model",
      "lineage",
      "sourceContentId",
      "body",
      "richBody",
      "status",
      "generateCover",
      "generateInlineImages",
      "useEditorialFeedback",
      "seoKeywords",
      "scheduledAt",
      "cover",
      "video",
      "adaptations",
      "approvedAt",
      "openedAt",
    ]) {
      expect(contentReuseCreateSchema.safeParse({ ...request, [field]: null }).success, field).toBe(
        false,
      );
    }
  });
  it("keeps retry consent-only and acknowledgements identity-only", () => {
    expect(contentReuseRetrySchema.parse(consent)).toEqual(consent);
    for (const field of Object.keys(request).filter((key) => !(key in consent))) {
      expect(
        contentReuseRetrySchema.safeParse({
          ...consent,
          [field]: request[field as keyof typeof request],
        }).success,
      ).toBe(false);
    }
    expect(
      contentReuseRetrySchema.safeParse({ ...consent, allowPaidGeneration: false }).success,
    ).toBe(false);
    expect(contentReuseResultSchema.parse({ id, status: "queued" })).toEqual({
      id,
      status: "queued",
    });
    expect(contentReuseResultSchema.safeParse({ id, status: "succeeded" }).success).toBe(false);
    expect(
      contentReuseResultSchema.safeParse({ id, status: "queued", material: "secret" }).success,
    ).toBe(false);
  });
  it("requires exact lowercase SHA-256 digests", () => {
    expect(contentReuseDigestSchema.safeParse("a0".repeat(32)).success).toBe(true);
    for (const digest of [
      "A".repeat(64),
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      ` ${"a".repeat(64)}`,
    ]) {
      expect(contentReuseDigestSchema.safeParse(digest).success).toBe(false);
    }
  });
  it("normalizes source newlines before the 8000-character bound without truncating or accepting blank/NUL", () => {
    const input = "a\r\n".repeat(4000);
    expect(contentReuseMaterialSchema.parse(input)).toBe("a\n".repeat(4000));
    expect(contentReuseMaterialSchema.parse("x".repeat(MAX_SOURCE_TEXT_LENGTH)).length).toBe(
      MAX_SOURCE_TEXT_LENGTH,
    );
    for (const input of ["", " \r\n\t", "text\0", "x".repeat(MAX_SOURCE_TEXT_LENGTH + 1)]) {
      expect(contentReuseMaterialSchema.safeParse(input).success).toBe(false);
    }
  });
  it("bounds previews and restricts saved eligibility while preserving all real origins", () => {
    for (const status of CONTENT_STATUSES)
      expect(contentReuseSourcePreviewSchema.safeParse({ ...source, status }).success).toBe(
        CONTENT_REUSE_ELIGIBLE_STATUSES.some((allowed) => allowed === status),
      );
    for (const origin of CONTENT_ORIGINS)
      expect(contentReuseSourcePreviewSchema.parse({ ...source, origin }).origin).toBe(origin);
    expect(
      contentReuseSourcePreviewSchema.safeParse({ ...source, material: "x".repeat(8001) }).success,
    ).toBe(false);
    expect(
      contentReuseSourcePreviewSchema.safeParse({ ...source, provider: "google" }).success,
    ).toBe(false);
  });
  it("binds exact nullable saved title and revision independently from delivery status", () => {
    expect(contentReuseSourceDigestPayloadSchema.parse(digestPayload)).toEqual(digestPayload);
    const titleOnly = contentReuseSourceDigestPayloadSchema.parse({
      ...digestPayload,
      title: "Changed\r\ntitle",
    });
    expect(titleOnly.title).toBe("Changed\r\ntitle");
    expect(titleOnly).not.toEqual(digestPayload);
    expect(
      contentReuseSourceDigestPayloadSchema.parse({ ...digestPayload, title: "" }),
    ).not.toEqual(digestPayload);
    expect(
      contentReuseSourceDigestPayloadSchema.parse({ ...digestPayload, bodyRevision: 1 }),
    ).not.toEqual(digestPayload);
    expect(
      contentReuseSourceDigestPayloadSchema.safeParse({ ...digestPayload, status: "published" })
        .success,
    ).toBe(false);
    expect(
      contentReuseSourceDigestPayloadSchema.safeParse({ ...digestPayload, version: "source-v2" })
        .success,
    ).toBe(false);
    expect(
      contentReuseSourceDigestPayloadSchema.safeParse({ ...digestPayload, title: "\0" }).success,
    ).toBe(false);
  });
  it("does not disclose titles, material or link identities for inaccessible or erased sources", () => {
    for (const state of ["unavailable", "redacted"]) {
      expect(contentReuseAttributionSchema.parse({ state, sourceRevision: 0 })).toEqual({
        state,
        sourceRevision: 0,
      });
      for (const field of ["title", "sourceContentId", "material", "digest", "origin"]) {
        expect(
          contentReuseAttributionSchema.safeParse({ state, sourceRevision: 0, [field]: null })
            .success,
        ).toBe(false);
      }
    }
    for (const origin of CONTENT_ORIGINS)
      expect(
        contentReuseAttributionSchema.safeParse({
          state: "available",
          sourceContentId: id,
          sourceRevision: 0,
          title: null,
          origin,
        }).success,
      ).toBe(true);
  });
  it("accepts bounded opaque auth actor IDs rather than requiring UUIDs", () => {
    for (const actor of ["user_auth_identity", "x", "x".repeat(255)])
      expect(contentReuseActorIdSchema.parse(actor)).toBe(actor);
    for (const actor of ["", "x".repeat(256), "a\0b"])
      expect(contentReuseActorIdSchema.safeParse(actor).success).toBe(false);
  });
  it("keeps ordinary generation contracts unchanged and freezes operation vocabulary", () => {
    expect(
      runCreateSchema.safeParse({ brandId: id, material: "text", channelIds: [id] }).success,
    ).toBe(true);
    expect(CONTENT_REUSE_OPERATIONS).toEqual(["reuse", "reuse-retry"]);
    expect(CONTENT_REUSE_TARGET_KINDS).toEqual(["content", "run"]);
    expect(CONTENT_REUSE_HASH_VERSION).toBe("parsed-dto-v1");
    expect(MAX_CONTENT_REUSE_OPERATIONS).toBe(10_000);
    for (const code of [
      "reuse_source_changed",
      "reuse_source_ineligible",
      "reuse_source_too_long",
      "reuse_source_redacted",
      "reuse_operation_limit",
      "content_delete_reuse_active",
    ] as const)
      expect(API_ERROR_CODES).toContain(code);
  });
});
