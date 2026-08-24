import { describe, expect, it } from "vitest";
import { getPublisher } from "./registry.js";
import { telegramPublisher } from "./telegram.js";

describe("getPublisher", () => {
  it("returns the adapter for an implemented platform", () => {
    expect(getPublisher("telegram")).toBe(telegramPublisher);
  });

  it("returns undefined for a platform with no adapter yet", () => {
    expect(getPublisher("vk")).toBeUndefined();
  });

  it("returns undefined for Object.prototype members, not an inherited function", () => {
    // `platform` comes straight from a database column. Without an own-property
    // check, these read back as truthy non-Publishers and the caller's
    // `if (!publisher)` guard passes — the failure then surfaces much later as
    // "publisher.publish is not a function" instead of "no adapter for this
    // platform".
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(getPublisher(name)).toBeUndefined();
    }
  });
});
