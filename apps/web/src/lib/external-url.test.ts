import { describe, expect, it } from "vitest";
import { isLinkableUrl } from "./external-url";

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
