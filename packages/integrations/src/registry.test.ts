import { PLATFORM_IDS, PUBLISHABLE_PLATFORM_IDS } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { getPublisher, PUBLISHABLE_PLATFORMS } from "./registry.js";
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

/**
 * The registry and `@pubrick/shared`'s declaration are one set, not two lists.
 *
 * The compiler already says so — `PUBLISHERS` is annotated
 * `Record<PublishablePlatformId, …>`, so a missing adapter and an undeclared
 * one are both build errors. These assert the same equality at runtime, which
 * is what the API's refusal (registry) and the channel picker's disabled
 * options (shared declaration) each rely on separately. If they ever disagree,
 * a person can pick a platform the API refuses, or be refused one it would
 * have accepted.
 */
describe("the publishable set", () => {
  it("is exactly what the registry holds an adapter for", () => {
    expect([...PUBLISHABLE_PLATFORMS]).toEqual([...PUBLISHABLE_PLATFORM_IDS].sort());
  });

  it("agrees with getPublisher for every platform the product names", () => {
    for (const id of PLATFORM_IDS) {
      expect({ id, hasAdapter: getPublisher(id) !== undefined }).toEqual({
        id,
        hasAdapter: (PUBLISHABLE_PLATFORM_IDS as readonly string[]).includes(id),
      });
    }
  });
});
