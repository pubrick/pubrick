import { describe, expect, it } from "vitest";
import {
  hashtagSuffix,
  normalizeHashtags,
  replaceHashtags,
  stripHashtagSuffix,
  withHashtags,
} from "./hashtags.js";

describe("channel hashtags", () => {
  it("normalizes and deduplicates a structured tag list", () => {
    expect(normalizeHashtags([" #new product ", "new product", "#launch", "  "])).toEqual([
      "new_product",
      "launch",
    ]);
    expect(hashtagSuffix(["#new product", "launch"])).toBe("#new_product #launch");
  });

  it("composes a canonical body once and repairs a partial trailing block", () => {
    expect(withHashtags("A post.", ["one", "two"])).toBe("A post.\n\n#one #two");
    expect(withHashtags("A post.\n\n#one #two", ["one", "two"])).toBe("A post.\n\n#one #two");
    expect(withHashtags("A post.\n\n#one", ["one", "two"])).toBe("A post.\n\n#one #two");
  });

  it("replaces managed tags without leaving the previous suffix in sent text", () => {
    const before = "A post.\n\n#one #two";
    expect(stripHashtagSuffix(before, ["one", "two"])).toBe("A post.");
    expect(replaceHashtags(before, ["one", "two"], ["three"])).toBe("A post.\n\n#three");
    expect(replaceHashtags(before, ["one", "two"], [])).toBe("A post.");
    expect(replaceHashtags("A post.\n\n#two #one", ["one", "two"], ["three"])).toBe(
      "A post.\n\n#three",
    );
    expect(replaceHashtags("A post.\n\n#two", ["one", "two"], ["one"])).toBe("A post.\n\n#one");
    expect(replaceHashtags("A post. #one\n\n#one #two", ["one", "two"], ["three"])).toBe(
      "A post. #one\n\n#three",
    );
    expect(stripHashtagSuffix("A post. #one", ["one"])).toBe("A post. #one");
    expect(replaceHashtags("A post. #one", ["one"], ["two"])).toBe("A post. #one\n\n#two");
  });
});
