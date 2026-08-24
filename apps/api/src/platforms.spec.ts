import { schema } from "@pubrick/db";
import { PLATFORM_IDS } from "@pubrick/shared";
import { describe, expect, it } from "vitest";

// The db column enum (schema.PLATFORMS) and the zod enum the API validates against
// (PLATFORM_IDS) are two hand-maintained lists in two packages that cannot import
// each other. Drift means either a platform the API accepts but the column rejects,
// or one silently unreachable. Both a type-level and a value-level assertion so the
// gate fails on typecheck AND on test.

type DbPlatform = (typeof schema.PLATFORMS)[number];
type SharedPlatform = (typeof PLATFORM_IDS)[number];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("platform enums", () => {
  it("db PLATFORMS and shared PLATFORM_IDS stay identical (same order)", () => {
    // Typecheck gate: this assignment stops compiling the moment the unions diverge.
    const unionsMatch: Equal<DbPlatform, SharedPlatform> = true;
    expect(unionsMatch).toBe(true);
    expect([...schema.PLATFORMS]).toEqual([...PLATFORM_IDS]);
  });
});
