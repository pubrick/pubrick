import { describe, expect, it } from "vitest";
import { loginHref, safeNextPath } from "./auth-routes";

describe("safeNextPath", () => {
  it("accepts an ordinary same-origin path", () => {
    expect(safeNextPath("/en/settings")).toBe("/en/settings");
    expect(safeNextPath("/en/content/42?filter=draft")).toBe("/en/content/42?filter=draft");
  });

  it("rejects nothing-at-all", () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath("")).toBeNull();
  });

  it("rejects an absolute URL, so ?next= cannot point off-site", () => {
    expect(safeNextPath("https://evil.example/steal")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("rejects the two protocol-relative forms that start with a slash", () => {
    // Both are read by browsers as "//host" — a leading "/" alone is not
    // proof of same-origin, which is the whole reason this function exists.
    expect(safeNextPath("//evil.example/steal")).toBeNull();
    expect(safeNextPath("/\\evil.example/steal")).toBeNull();
  });
});

describe("loginHref", () => {
  it("is the plain login screen when there is nowhere to return to", () => {
    expect(loginHref("en")).toBe("/en/login");
    expect(loginHref("ru", null)).toBe("/ru/login");
  });

  it("carries the return path, percent-encoded", () => {
    expect(loginHref("en", "/en/settings")).toBe("/en/login?next=%2Fen%2Fsettings");
  });

  it("drops a return path that safeNextPath refuses", () => {
    expect(loginHref("en", "//evil.example")).toBe("/en/login");
    expect(loginHref("en", "https://evil.example")).toBe("/en/login");
  });
});
