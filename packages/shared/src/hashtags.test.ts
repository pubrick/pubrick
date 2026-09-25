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
    expect(normalizeHashtags(["foo/bar", "a.b", "#Тест!", "✨"])).toEqual([
      "foo_bar",
      "a_b",
      "Тест",
    ]);
    expect(hashtagSuffix(["#new product", "launch"])).toBe("#new_product #launch");
  });

  it("composes authored text without claiming ownership of a tag-only paragraph", () => {
    expect(withHashtags("A post.", ["one", "two"])).toBe("A post.\n\n#one #two");
    expect(withHashtags("A post.\n\n#organic", ["organic", "launch"])).toBe(
      "A post.\n\n#organic\n\n#organic #launch",
    );
    expect(
      replaceHashtags("A post.\n\n#organic\n\n#organic #launch", ["organic", "launch"], ["news"]),
    ).toBe("A post.\n\n#organic\n\n#news");
  });

  it("replaces managed tags without leaving the previous suffix in sent text", () => {
    const before = "A post.\n\n#one #two";
    expect(stripHashtagSuffix(before, ["one", "two"])).toBe("A post.");
    expect(replaceHashtags(before, ["one", "two"], ["three"])).toBe("A post.\n\n#three");
    expect(replaceHashtags(before, ["one", "two"], [])).toBe("A post.");
    expect(replaceHashtags("A post.\n\n#two #one", ["one", "two"], ["three"])).toBe(
      "A post.\n\n#two #one\n\n#three",
    );
    expect(replaceHashtags("A post.\n\n#two", ["one", "two"], ["one"])).toBe(
      "A post.\n\n#two\n\n#one",
    );
    expect(replaceHashtags("A post. #one\n\n#one #two", ["one", "two"], ["three"])).toBe(
      "A post. #one\n\n#three",
    );
    expect(stripHashtagSuffix("A post. #one", ["one"])).toBe("A post. #one");
    expect(replaceHashtags("A post. #one", ["one"], ["two"])).toBe("A post. #one\n\n#two");
  });
});
