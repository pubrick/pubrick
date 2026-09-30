import { HttpException } from "@nestjs/common";
import { BillingGrowthError, ResourceAdmissionError } from "@pubrick/db";
import { describe, expect, it } from "vitest";
import { withQuotaErrors } from "./tenant-quota";

describe("quota errors at the HTTP repository boundary", () => {
  it.each([
    ["subscription_required", 402],
    ["resource_limit", 409],
    ["billing_identity_mismatch", 503],
  ] as const)("translates %s while preserving the resource", async (code, status) => {
    const refusal = new BillingGrowthError(code, "mediaBytes");
    const error = await withQuotaErrors(async () => {
      throw refusal;
    }).catch((value) => value);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toEqual({ code, message: code, resource: "mediaBytes" });
  });
  it.each([
    ["target_unavailable", 404, "not_found"],
    ["invalid_growth", 503, "unavailable"],
    ["growth_mismatch", 503, "unavailable"],
  ] as const)(
    "does not expose internal admission details for %s",
    async (code, status, publicCode) => {
      const error = await withQuotaErrors(async () => {
        throw new ResourceAdmissionError(code, "channels");
      }).catch((value) => value);
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({
        code: publicCode,
        message: publicCode,
      });
    },
  );
  it("preserves unrelated errors and successful results", async () => {
    const error = new Error("original storage failure");
    await expect(
      withQuotaErrors(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(withQuotaErrors(async () => "inserted")).resolves.toBe("inserted");
  });
});
