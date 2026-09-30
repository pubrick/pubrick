import { describe, expect, it } from "vitest";
import { resolveTenantQuotaMode, TenantQuotaConfigurationError } from "./tenant-quota-config.js";

describe("server tenant quota identity configuration", () => {
  it("keeps default and explicit self-hosted bypass independent of payment configuration", () => {
    expect(resolveTenantQuotaMode({})).toEqual({ mode: "self-hosted" });
    expect(
      resolveTenantQuotaMode(
        {
          PUBRICK_DEPLOYMENT_MODE: "self-hosted",
          BILLING_DRIVER: "unused",
          BILLING_ACCOUNT_ID: "unused",
        },
        "production",
      ),
    ).toEqual({ mode: "self-hosted" });
  });
  it("rejects malformed modes instead of falling back to self-hosted admission", () => {
    for (const mode of ["", "unknown", "Hosted", "hosted "])
      expect(() => resolveTenantQuotaMode({ PUBRICK_DEPLOYMENT_MODE: mode })).toThrow(
        TenantQuotaConfigurationError,
      );
  });
  it("requires exact configured hosted identity without inventing an account", () => {
    for (const input of [
      {},
      { BILLING_DRIVER: "stripe-sandbox" },
      { BILLING_ACCOUNT_ID: "acct_test" },
      { BILLING_DRIVER: "stripe-sandbox", BILLING_ACCOUNT_ID: "fixture_test" },
      { BILLING_DRIVER: "fixture", BILLING_ACCOUNT_ID: "acct_test" },
      { BILLING_DRIVER: "stripe-live", BILLING_ACCOUNT_ID: "acct_test" },
    ]) {
      expect(() => resolveTenantQuotaMode({ PUBRICK_DEPLOYMENT_MODE: "hosted", ...input })).toThrow(
        TenantQuotaConfigurationError,
      );
    }
  });
  it("returns matching structural sandbox identity for both supported drivers", () => {
    expect(
      resolveTenantQuotaMode(
        {
          PUBRICK_DEPLOYMENT_MODE: "hosted",
          BILLING_DRIVER: "stripe-sandbox",
          BILLING_ACCOUNT_ID: "acct_test",
        },
        "production",
      ),
    ).toEqual({
      mode: "hosted",
      identity: { provider: "stripe", environment: "sandbox", accountId: "acct_test" },
    });
    expect(
      resolveTenantQuotaMode(
        {
          PUBRICK_DEPLOYMENT_MODE: "hosted",
          BILLING_DRIVER: "fixture",
          BILLING_ACCOUNT_ID: "fixture_test",
        },
        "test",
      ),
    ).toEqual({
      mode: "hosted",
      identity: { provider: "fixture", environment: "sandbox", accountId: "fixture_test" },
    });
  });
  it("refuses production fixtures and malformed account IDs without echoing operator input", () => {
    expect(() =>
      resolveTenantQuotaMode(
        {
          PUBRICK_DEPLOYMENT_MODE: "hosted",
          BILLING_DRIVER: "fixture",
          BILLING_ACCOUNT_ID: "fixture_test",
        },
        "production",
      ),
    ).toThrow(TenantQuotaConfigurationError);
    for (const accountId of ["acct_", " acct_test", "acct_test\n", "acct_secret@host"]) {
      try {
        resolveTenantQuotaMode({
          PUBRICK_DEPLOYMENT_MODE: "hosted",
          BILLING_DRIVER: "stripe-sandbox",
          BILLING_ACCOUNT_ID: accountId,
        });
        expect.fail("Invalid identity accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(TenantQuotaConfigurationError);
        expect(String(error)).toBe("TenantQuotaConfigurationError: invalid_configuration");
      }
    }
  });
});
