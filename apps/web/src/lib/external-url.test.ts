import { describe, expect, it } from "vitest";
import { isHttpUrl, isLinkableUrl } from "./external-url";

describe("isHttpUrl", () => {
  it("accepts http and https, case-insensitively on the scheme", () => {
    expect(isHttpUrl("http://example.com/story")).toBe(true);
    expect(isHttpUrl("HTTPS://Example.com/story")).toBe(true);
  });

  it("rejects a javascript: URL that parses to an ordinary-looking host", () => {
    // `new URL(...)`.hostname is "example.com" for this string; the scheme is
    // what an href acts on.
    expect(isHttpUrl("javascript://example.com/%0aalert(1)")).toBe(false);
    expect(isHttpUrl("vbscript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects null, undefined and a bare string", () => {
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("isLinkableUrl", () => {
  it("accepts a public https t.me link", () => {
    expect(isLinkableUrl("https://t.me/mychannel/1")).toBe(true);
  });

  it("accepts the private-channel https t.me/c form", () => {
    expect(isLinkableUrl("https://t.me/c/9876543210/4711")).toBe(true);
  });

  it("rejects http (non-https)", () => {
    expect(isLinkableUrl("http://t.me/mychannel/1")).toBe(false);
  });

  it("rejects a javascript: URL", () => {
    expect(isLinkableUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects a bare string that isn't a URL at all", () => {
    expect(isLinkableUrl("mychannel")).toBe(false);
  });

  it("rejects null", () => {
    expect(isLinkableUrl(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isLinkableUrl(undefined)).toBe(false);
  });
});
