import { describe, expect, it } from "vitest";
import { hasOrganizationRole, isOrganizationManager } from "./organization-roles.js";

describe("effective organization roles", () => {
  it("unions roles and preserves repeated editorial role restrictions", () => {
    expect(isOrganizationManager("owner,admin")).toBe(true);
    expect(isOrganizationManager("member,admin")).toBe(true);
    expect(isOrganizationManager("author,author")).toBe(false);
    expect(hasOrganizationRole("author,author", ["editor"])).toBe(false);
    expect(hasOrganizationRole("author,editor", ["editor"])).toBe(true);
    expect(hasOrganizationRole("author,member", ["member"])).toBe(true);
  });
  it("matches Better Auth's untrimmed names and denies unknown roles", () => {
    for (const value of [undefined, null, "", "unknown", " administrator", " ADMIN"]) {
      expect(isOrganizationManager(value)).toBe(false);
      expect(hasOrganizationRole(value, ["member", "author", "editor"])).toBe(false);
    }
    expect(isOrganizationManager("member, admin")).toBe(false);
    expect(hasOrganizationRole("member, admin", ["member"])).toBe(true);
  });
});
