import { describe, expect, it } from "vitest";
import { deriveOrigin } from "./origin";

describe("deriveOrigin", () => {
  it("reads a typed post with typed channel copy as human-written", () => {
    expect(deriveOrigin({ origin: "human", adaptations: [{ origin: "human" }] })).toBe("human");
  });

  it("reads a model-drafted post as AI", () => {
    expect(deriveOrigin({ origin: "ai", adaptations: [{ origin: "ai" }] })).toBe("ai");
  });

  it("reads a human body with any AI channel body as AI-adapted", () => {
    expect(
      deriveOrigin({ origin: "human", adaptations: [{ origin: "human" }, { origin: "ai" }] }),
    ).toBe("aiAdapted");
  });

  it("does not let human channel bodies launder an AI-written item", () => {
    // The item's own origin wins: the master body is what a reader edits and
    // what every channel starts from. Reporting "human-written" here would
    // over-claim human authorship, which is the one direction provenance is
    // never allowed to fail in.
    expect(deriveOrigin({ origin: "ai", adaptations: [{ origin: "human" }] })).toBe("ai");
  });

  it("handles an item with no adaptations at all", () => {
    expect(deriveOrigin({ origin: "human", adaptations: [] })).toBe("human");
    expect(deriveOrigin({ origin: "ai", adaptations: [] })).toBe("ai");
  });
});
