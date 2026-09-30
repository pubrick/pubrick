import { describe, expect, it } from "vitest";
import {
  admissionSeats,
  assertCreationPolicy,
  assertInvitationRole,
  assertMemberRemoval,
  assertRoleUpdate,
  HostedAdmissionError,
  normalizeHostedRoles,
} from "./hosted-admission-policy.js";

describe("hosted admission policy", () => {
  it("deduplicates legacy memberships and pending emails without altering rows", () => {
    expect(
      admissionSeats(
        [
          { userId: "u", email: "A@EXAMPLE.COM" },
          { userId: "u", email: "A@example.com" },
        ],
        ["a@example.com", "B@example.com", "b@example.com"],
      ),
    ).toBe(2);
  });
  it("counts distinct accounts independently of duplicate email projections", () => {
    expect(
      admissionSeats(
        [
          { userId: "a", email: "x@e.com" },
          { userId: "b", email: "x@e.com" },
        ],
        [],
      ),
    ).toBe(2);
  });
  it("limits current owned workspaces and rolling creations separately", () => {
    const p = { maxOwnedWorkspaces: 2, maxCreationsPerDay: 3 };
    expect(() => assertCreationPolicy(p, 2, 0)).toThrowError("owned_workspace_limit");
    expect(() => assertCreationPolicy(p, 0, 3)).toThrowError("creation_rate_limit");
    expect(() => assertCreationPolicy(p, 0, 2)).not.toThrow();
    expect(() => assertCreationPolicy({ ...p, maxOwnedWorkspaces: 0 }, 0, 0)).toThrowError(
      "invalid_policy",
    );
  });
  it("preserves ordinary member invitation limits and manager resends", () => {
    expect(() => assertInvitationRole("member", "member", false)).not.toThrow();
    expect(() => assertInvitationRole("member", "admin", false)).toThrow(HostedAdmissionError);
    expect(() => assertInvitationRole("member", "member", true)).toThrow(HostedAdmissionError);
    expect(() => assertInvitationRole("author", "member", false)).toThrow(HostedAdmissionError);
    expect(() => assertInvitationRole("owner", "editor", true)).not.toThrow();
    expect(() => assertInvitationRole("admin", "owner", false)).toThrow(HostedAdmissionError);
    expect(() => assertInvitationRole("owner", "owner,admin", false)).not.toThrow();
  });
  it("keeps the last distinct owner and refuses an admin removing any owner", () => {
    expect(() => assertMemberRemoval("owner", "owner", 1)).toThrowError("last_owner");
    expect(() => assertMemberRemoval("admin", "owner", 2)).toThrowError("forbidden");
    expect(() => assertMemberRemoval("member", "member", 2)).toThrowError("forbidden");
    expect(() => assertMemberRemoval("owner", "owner", 2)).not.toThrow();
  });
  it("normalizes supported multi-role requests and protects owner demotion", () => {
    expect(normalizeHostedRoles([" editor, member ", "editor"])).toBe("editor,member");
    expect(() => normalizeHostedRoles("member,unknown")).toThrowError("invalid_input");
    expect(() => assertRoleUpdate("admin", "owner", "member", 2)).toThrowError("forbidden");
    expect(() => assertRoleUpdate("owner", "owner", "member", 1)).toThrowError("last_owner");
    expect(() => assertRoleUpdate("owner", "member", "owner,editor", 1)).not.toThrow();
  });
});
