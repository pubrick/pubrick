import { PAID_GENERATION_CONSENT_VERSION } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { hashContentReuseRequest, hashContentReuseSource } from "./content-reuse-hash";

const contentId = "11111111-1111-4111-8111-111111111111";
const brandId = "22222222-2222-4222-8222-222222222222";
const channelId = "33333333-3333-4333-8333-333333333333";
const source = {
  version: "source-v1" as const,
  contentId,
  brandId,
  title: "Saved master",
  bodyRevision: 7,
  material: "First line.\nSecond line.",
};
const consent = {
  allowPaidGeneration: true,
  consentVersion: PAID_GENERATION_CONSENT_VERSION,
};
const request = {
  ...consent,
  expectedSourceRevision: 7,
  expectedSourceDigest: "a".repeat(64),
  contentType: "social_post",
  channelIds: [channelId],
};

describe("evergreen source and operation identities", () => {
  it("matches an independently computed source SHA-256 vector", () => {
    expect(hashContentReuseSource(source)).toBe(
      "15a5b1325579f28a3f4704faed3a5e72d1a648e258de73afac6137b386b7318f",
    );
  });

  it("matches an independently computed versioned retry envelope", () => {
    expect(hashContentReuseRequest("reuse-retry", contentId, consent)).toBe(
      "613e67275b6a4b4af9c85e2af6051555023df1d8e4f71ea3c590b3df1a10294b",
    );
  });

  it("normalizes textarea newlines without trimming saved evidence", () => {
    expect(hashContentReuseSource({ ...source, material: "First line.\r\nSecond line." })).toBe(
      hashContentReuseSource(source),
    );
    expect(hashContentReuseSource({ ...source, material: ` ${source.material}` })).not.toBe(
      hashContentReuseSource(source),
    );
    expect(hashContentReuseSource({ ...source, title: null })).not.toBe(
      hashContentReuseSource({ ...source, title: "" }),
    );
  });

  it("binds every saved source identity field", () => {
    for (const change of [
      { contentId: channelId },
      { brandId: channelId },
      { title: "Edited title" },
      { bodyRevision: 8 },
      { material: "Edited body" },
    ])
      expect(hashContentReuseSource({ ...source, ...change })).not.toBe(
        hashContentReuseSource(source),
      );
  });

  it("uses parsed DTO identity independent of property order and absent optionals", () => {
    const reordered = Object.fromEntries(Object.entries(request).reverse());
    expect(hashContentReuseRequest("reuse", contentId, reordered)).toBe(
      hashContentReuseRequest("reuse", contentId, { ...request, title: undefined }),
    );
    expect(
      hashContentReuseRequest("reuse", contentId, { ...request, brief: "New direction" }),
    ).not.toBe(hashContentReuseRequest("reuse", contentId, request));
  });

  it("binds deleted-target replay to its original path and operation domain", () => {
    expect(hashContentReuseRequest("reuse", contentId, request)).not.toBe(
      hashContentReuseRequest("reuse", channelId, request),
    );
    expect(hashContentReuseRequest("reuse-retry", contentId, consent)).not.toBe(
      hashContentReuseRequest("reuse-retry", channelId, consent),
    );
    expect(hashContentReuseRequest("reuse", contentId, request)).not.toBe(
      hashContentReuseRequest("reuse-retry", contentId, consent),
    );
  });

  it("rejects unconsented, unparsed and invalid target identities", () => {
    expect(() =>
      hashContentReuseRequest("reuse", contentId, { ...request, allowPaidGeneration: false }),
    ).toThrow();
    expect(() =>
      hashContentReuseRequest("reuse-retry", contentId, { ...consent, material: "Hidden input" }),
    ).toThrow();
    expect(() => hashContentReuseRequest("reuse", "deleted", request)).toThrow();
    expect(() => hashContentReuseSource({ ...source, material: " " })).toThrow();
  });
});
