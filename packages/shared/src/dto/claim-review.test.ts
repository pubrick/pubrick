import { describe, expect, it } from "vitest";
import {
  acceptedClaimCorrectionDtoSchema,
  acceptedClaimCorrectionListDtoSchema,
  acceptedClaimCorrectionListQuerySchema,
  claimCorrectionProposalDtoSchema,
  claimCorrectionRequestSchema,
} from "./claim-review.js";
import { MAX_BODY_LENGTH } from "./content.js";

const id = "99999999-9999-4999-8999-999999999999";

describe("claim correction wire contract", () => {
  it("requires one exact-body claim index", () => {
    expect(
      claimCorrectionRequestSchema.safeParse({ expectedBody: "Draft", reviewId: id, claimIndex: 0 })
        .success,
    ).toBe(true);
    expect(
      claimCorrectionRequestSchema.safeParse({
        expectedBody: "Draft",
        reviewId: id,
        claimIndex: -1,
      }).success,
    ).toBe(false);
    expect(
      claimCorrectionRequestSchema.safeParse({
        expectedBody: "x".repeat(MAX_BODY_LENGTH + 1),
        reviewId: id,
        claimIndex: 0,
      }).success,
    ).toBe(false);
    expect(
      claimCorrectionRequestSchema.safeParse({
        expectedBody: "Draft",
        reviewId: id,
        claimIndex: 0,
        apply: true,
      }).success,
    ).toBe(false);
  });

  it("keeps a source quote, nonempty replacement and cited evidence", () => {
    const proposal = {
      id,
      contentItemId: id,
      reviewId: id,
      claimIndex: 0,
      sourceBody: "The museum opened in 2024.",
      claim: "The museum opened in 2024.",
      replacement: "The museum opened in 2023.",
      reason: "The archive gives the year as 2023.",
      evidence: [
        { title: "Museum archive", url: "https://example.org/archive", snippet: "Opened in 2023." },
      ],
      createdAt: "2026-09-25T12:00:00.000Z",
    };
    expect(claimCorrectionProposalDtoSchema.safeParse(proposal).success).toBe(true);
    expect(claimCorrectionProposalDtoSchema.safeParse({ ...proposal, evidence: [] }).success).toBe(
      false,
    );
    expect(
      claimCorrectionProposalDtoSchema.safeParse({ ...proposal, replacement: " \t" }).success,
    ).toBe(false);
    expect(
      claimCorrectionProposalDtoSchema.safeParse({
        ...proposal,
        sourceBody: "x".repeat(MAX_BODY_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("pages accepted correction receipts with the saved citations", () => {
    const receipt = {
      id,
      contentItemId: id,
      reviewId: id,
      fragmentVersionId: id,
      claimIndex: 0,
      sourceBodyHash: "a".repeat(64),
      claim: "The museum opened in 2024.",
      replacement: "The museum opened in 2023.",
      reason: "The archive gives the year as 2023.",
      evidence: [
        { title: "Museum archive", url: "https://example.org/archive", snippet: "Opened in 2023." },
      ],
      acceptedAt: "2026-09-25T12:00:00.000Z",
    };
    expect(acceptedClaimCorrectionDtoSchema.safeParse(receipt).success).toBe(true);
    expect(acceptedClaimCorrectionDtoSchema.safeParse({ ...receipt, evidence: [] }).success).toBe(
      false,
    );
    expect(
      acceptedClaimCorrectionListDtoSchema.safeParse({ rows: [receipt], nextCursor: id }).success,
    ).toBe(true);
    expect(acceptedClaimCorrectionListQuerySchema.safeParse({ cursor: id }).success).toBe(true);
    expect(acceptedClaimCorrectionListQuerySchema.safeParse({ cursor: "invalid" }).success).toBe(
      false,
    );
  });
});
