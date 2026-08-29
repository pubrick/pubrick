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
 * The fourth badge, and the reference it is allowed to read.
 *
 * Design §3 is the authority: the badge asks "does the body still match ANY
 * `ai` row", while the publish gate asks a different question of the same rows
 * and reads only the FIRST one. In increment 2a there is exactly one `ai` row
 * per level, so the two coincide and a wrong choice here would look correct —
 * until 2b's refine rows write the second, at which point the gate's rule would
 * flip an accepted refinement to "human-edited" with nothing to notice it.
 */
describe("deriveOrigin — human-edited (design §3, §5)", () => {
  it("reads human-edited once an ai body matches no ai version", () => {
    expect(
      deriveOrigin({
        origin: "ai",
        adaptations: [],
        aiVersionBodies: { item: ["The AI wrote this."], adaptations: {} },
        body: "I rewrote it.",
      }),
    ).toBe("humanEdited");
  });

  it("still reads ai-drafted while the body matches any ai version", () => {
    expect(
      deriveOrigin({
        origin: "ai",
        adaptations: [],
        aiVersionBodies: { item: ["The AI wrote this."], adaptations: {} },
        body: "The AI wrote this.",
      }),
    ).toBe("ai");
  });

  /**
   * ANY, not the first. Two `ai` rows where the body matches the SECOND is the
   * only fixture that can tell §3's rule apart from the gate's, and it is the
   * shape 2b creates on the first accepted refinement.
   */
  it("reads ai-drafted when the body matches a later ai version, not the first", () => {
    expect(
      deriveOrigin({
        origin: "ai",
        adaptations: [],
        aiVersionBodies: {
          item: ["The AI wrote this.", "A later AI refinement."],
          adaptations: {},
        },
        body: "A later AI refinement.",
      }),
    ).toBe("ai");
  });

  it("reads human-edited only when the body matches none of several ai versions", () => {
    expect(
      deriveOrigin({
        origin: "ai",
        adaptations: [],
        aiVersionBodies: {
          item: ["The AI wrote this.", "A later AI refinement."],
          adaptations: {},
        },
        body: "Neither of those.",
      }),
    ).toBe("humanEdited");
  });

  /**
   * Missing evidence is not evidence of an edit. An `ai` item whose version
   * rows are absent — an older payload, the LIST endpoint (which returns no
   * `aiVersionBodies` at all), a row that was never written — must keep reading
   * "AI-drafted". Answering "human-edited" there would over-claim human
   * authorship on a body no human has touched, which is the single direction
   * this whole feature is not allowed to fail in.
   */
  it("keeps reading ai-drafted when there is no reference text to compare against", () => {
    expect(
      deriveOrigin({
        origin: "ai",
        adaptations: [],
        aiVersionBodies: { item: [], adaptations: {} },
        body: "Whatever this is.",
      }),
    ).toBe("ai");
    // The list screen's shape: an item with a body but no version bodies.
    expect(deriveOrigin({ origin: "ai", adaptations: [], body: "Whatever this is." })).toBe("ai");
    // ...and version bodies with no body to compare them to.
    expect(
      deriveOrigin({
        origin: "ai",
        adaptations: [],
        aiVersionBodies: { item: ["The AI wrote this."], adaptations: {} },
      }),
    ).toBe("ai");
  });

  it("leaves a human-written item alone, whatever ai version bodies it carries", () => {
    // A human item's badge is decided by its adaptations, never by the item's
    // own version rows: `humanEdited` is a refinement of `ai`, not of `human`.
    expect(
      deriveOrigin({
        origin: "human",
        adaptations: [{ origin: "ai" }],
        aiVersionBodies: { item: ["Something else entirely."], adaptations: {} },
        body: "I typed this.",
      }),
    ).toBe("aiAdapted");
  });
});
