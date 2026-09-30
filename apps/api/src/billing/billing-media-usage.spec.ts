import { createDb } from "@pubrick/db";
import { afterEach, expect, it, vi } from "vitest";
import { BillingRepository } from "./billing.repository";

const state = vi.hoisted(() => ({ bytes: 1656, error: undefined as Error | undefined }));
vi.mock("@pubrick/db", async (original) => {
  const actual = await original<typeof import("@pubrick/db")>();
  class MediaStorageUsageError extends Error {
    constructor(readonly code: "storage_reconciliation_required" | "invalid_storage_usage") {
      super(code);
    }
  }
  return {
    ...actual,
    MediaStorageUsageError,
    getTenantMediaStorageUsage: vi.fn(async (orgId: string) => {
      expect(orgId).toBe("org-media-status");
      if (state.error) throw state.error;
      return state.bytes;
    }),
    resolveBillingEntitlement: vi.fn(async () => ({
      decision: "active",
      identity: { provider: "fixture", environment: "sandbox", accountId: "fixture_media_status" },
      planId: "known",
      version: "v1",
      limits: { seats: 2, brands: 2, channels: 2, mediaBytes: 4000, concurrentJobs: 1 },
      accessUntil: new Date("2030-01-01"),
    })),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  state.error = undefined;
});
function fixture() {
  const connection = createDb("postgres://unused"); // Lazy native pool: no query or connection is opened.
  const repository = new BillingRepository(connection.db, {
    provider: "fixture",
    environment: "sandbox",
    accountId: "fixture_media_status",
  });
  // Exercise the real status mapper with database-reader results, without an app/bootstrap/DB gate.
  const rows = [
    [{ role: "owner" }],
    [{ subscriptionId: "sub_fixture" }],
    [{ status: "active", cancelAtPeriodEnd: false }],
    [{ customerId: "cus_fixture", deleted: false }],
    [],
    [{ userId: "user", email: "user@example.test" }],
    [],
    [{ brands: "1", channels: "1", mediaBytes: "1234", concurrentJobs: "0" }],
  ];
  const query = () => {
    const result = Promise.resolve(rows.shift() ?? []);
    return Object.assign(result, {
      from: () => result,
      where: () => result,
      innerJoin: () => result,
      for: () => result,
    });
  };
  vi.spyOn(connection.db, "transaction").mockImplementation(async (action) => {
    const tx = { select: query } as unknown as Parameters<typeof action>[0];
    return action(tx);
  });
  // Admission/ownership locking has its own native gate; this test targets media accounting errors only.
  Object.defineProperty(repository, "organization", { value: async () => true });
  return repository;
}
it("status uses the same retained-byte total as resource admission", async () => {
  const result = await fixture().view("org-media-status", "user");
  expect(result.usage.mediaBytes).toBe(1656);
});
it("unknown historical cleanup bytes preserve known subscription and management facts", async () => {
  const { MediaStorageUsageError } = await import("@pubrick/db");
  state.error = new MediaStorageUsageError("storage_reconciliation_required");
  const result = await fixture().view("org-media-status", "user");
  expect(result).toMatchObject({
    live: true,
    plan: { id: "known", version: "v1" },
    customer: true,
    canManage: true,
    usage: { seats: 1, brands: 1, channels: 1, mediaBytes: null, concurrentJobs: 0 },
  });
});
it("unexpected database/accounting failures still propagate instead of pretending an unknown count", async () => {
  state.error = new Error("synthetic database failure");
  await expect(fixture().view("org-media-status", "user")).rejects.toBe(state.error);
  const { MediaStorageUsageError } = await import("@pubrick/db");
  state.error = new MediaStorageUsageError("invalid_storage_usage");
  await expect(fixture().view("org-media-status", "user")).rejects.toBe(state.error);
});
