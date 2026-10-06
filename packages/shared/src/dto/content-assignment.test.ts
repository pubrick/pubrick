import { describe, expect, it } from "vitest";
import {
  contentAssignmentDtoSchema,
  contentAssignmentFilterSchema,
  contentAssignmentUpdateSchema,
} from "./content-assignment.js";

describe("content assignment contracts", () => {
  it("requires a revision even for clearing responsibility", () => {
    expect(contentAssignmentUpdateSchema.parse({ memberId: null, expectedRevision: 0 })).toEqual({
      memberId: null,
      expectedRevision: 0,
    });
    expect(contentAssignmentUpdateSchema.safeParse({ memberId: null }).success).toBe(false);
  });
  it("rejects invalid revisions and caller-supplied tenant/actor fields", () => {
    for (const expectedRevision of [-1, 0.5, 2_147_483_647])
      expect(
        contentAssignmentUpdateSchema.safeParse({ memberId: "member", expectedRevision }).success,
      ).toBe(false);
    expect(
      contentAssignmentUpdateSchema.safeParse({
        memberId: "member",
        expectedRevision: 1,
        userId: "another",
      }).success,
    ).toBe(false);
    expect(
      contentAssignmentUpdateSchema.safeParse({
        memberId: "member",
        expectedRevision: 1,
        orgId: "another",
      }).success,
    ).toBe(false);
  });
  it("accepts auth membership IDs while rejecting empty or database-invalid text", () => {
    expect(
      contentAssignmentUpdateSchema.safeParse({
        memberId: "auth-member-legacy",
        expectedRevision: 2,
      }).success,
    ).toBe(true);
    for (const memberId of ["", "a\u0000b", "a".repeat(256)])
      expect(
        contentAssignmentUpdateSchema.safeParse({ memberId, expectedRevision: 0 }).success,
      ).toBe(false);
  });
  it("limits queue filters to the three supported scopes", () => {
    for (const filter of ["all", "mine", "unassigned"])
      expect(contentAssignmentFilterSchema.safeParse(filter).success).toBe(true);
    expect(contentAssignmentFilterSchema.safeParse("someone-else").success).toBe(false);
  });
  it("represents a removed membership as retained but unavailable", () => {
    expect(
      contentAssignmentDtoSchema.parse({
        revision: 3,
        assignee: {
          memberId: "gone",
          userId: "old-user",
          name: "Former teammate",
          eligible: false,
        },
        members: [],
        history: { rows: [], nextCursor: null },
      }).assignee?.eligible,
    ).toBe(false);
  });
});
