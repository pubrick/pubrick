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

/**
 * The fourth badge.
 *
 * The comparison behind it — "does the body still match ANY `ai` row", design
 * §3's middle reference — is `matchesAnyAiVersion` in `@pubrick/shared`, run by
 * the API and delivered as `bodyIsAiVerbatim`. Its own tests live beside it.
 * What is left for this function is the mapping, and the fail-safe.
 */
describe("deriveOrigin — human-edited (design §3, §5)", () => {
  it("reads human-edited once the api reports the body is no longer verbatim", () => {
    expect(deriveOrigin({ origin: "ai", adaptations: [], bodyIsAiVerbatim: false })).toBe(
      "humanEdited",
    );
  });

  it("still reads ai-drafted while the body is verbatim", () => {
    expect(deriveOrigin({ origin: "ai", adaptations: [], bodyIsAiVerbatim: true })).toBe("ai");
  });

  /**
   * Missing evidence is not evidence of an edit. An `ai` item with no verdict
   * — a payload written before the field existed — must keep reading
   * "AI-drafted". Answering "human-edited" there would over-claim human
   * authorship on a body no human has touched, which is the single direction
   * this whole feature is not allowed to fail in.
   *
   * `=== false` and not `!bodyIsAiVerbatim` for exactly that reason: the two
   * differ only on `undefined`, and only in the unsafe direction.
   */
  it("keeps reading ai-drafted when the api gave no verdict at all", () => {
    expect(deriveOrigin({ origin: "ai", adaptations: [] })).toBe("ai");
    expect(deriveOrigin({ origin: "ai", adaptations: [], bodyIsAiVerbatim: undefined })).toBe("ai");
  });

  it("shows the badge on a queue card, which carries the same boolean", () => {
    // The whole point of a boolean rather than the version bodies: the LIST
    // response can afford it, so a rewritten item reads "Human-edited" on the
    // card and on the screen it opens — design §5's argument for shipping the
    // lens off by default is that the badge already carries the claim on every
    // card, and it did not until the list carried this field.
    const listRow = {
      origin: "ai" as const,
      adaptations: [{ origin: "ai" as const }],
      bodyIsAiVerbatim: false,
    };
    expect(deriveOrigin(listRow)).toBe("humanEdited");
  });

  it("leaves a human-written item alone, whatever the verdict on its body says", () => {
    // A human item's badge is decided by its adaptations, never by a
    // comparison against AI version rows: `humanEdited` is a refinement of
    // `ai`, not of `human`.
    expect(
      deriveOrigin({
        origin: "human",
        adaptations: [{ origin: "ai" }],
        bodyIsAiVerbatim: false,
      }),
    ).toBe("aiAdapted");
    expect(
      deriveOrigin({
        origin: "human",
        adaptations: [{ origin: "human" }],
        bodyIsAiVerbatim: false,
      }),
    ).toBe("human");
  });
});
