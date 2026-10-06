import { describe, expect, it } from "vitest";
import {
  frozenMetaPublicationInputSchema,
  META_PUBLICATION_PHASES,
  META_PUBLICATION_QUEUE_OPTIONS,
  metaPublicationIdentitySchema,
} from "./meta-publication.js";

describe("frozen Meta delivery contracts", () => {
  it("keeps public send intent separate from unknown nonpublic preparation", () => {
    expect(META_PUBLICATION_PHASES).toContain("preparation_unknown");
    expect(META_PUBLICATION_PHASES).toContain("final_unknown");
    expect(META_PUBLICATION_PHASES).toContain("published_without_receipt");
    expect(META_PUBLICATION_QUEUE_OPTIONS.retryLimit).toBe(0);
  });
  it.each(["url", "accessToken", "imageCapability", "video"])(
    "refuses %s in the immutable exported input",
    (field) => {
      expect(
        frozenMetaPublicationInputSchema.safeParse({
          version: 1,
          platform: "threads",
          text: "Reviewed text",
          [field]: "secret",
        }).success,
      ).toBe(false);
    },
  );
  it("preserves exact reviewed text instead of trimming or replacing it", () => {
    const text = "  literal & text\n\n";
    expect(
      frozenMetaPublicationInputSchema.parse({ version: 1, platform: "threads", text }).text,
    ).toBe(text);
  });
  it("rejects a missing generation fence or unknown input version", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(
      metaPublicationIdentitySchema.safeParse({
        orgId: "o1",
        brandId: id,
        adaptationId: id,
        channelId: id,
        attempt: 1,
        inputHash: "a".repeat(64),
        target: "threads:12345",
      }).success,
    ).toBe(false);
    expect(
      frozenMetaPublicationInputSchema.safeParse({ version: 2, platform: "threads", text: "Text" })
        .success,
    ).toBe(false);
  });
});
