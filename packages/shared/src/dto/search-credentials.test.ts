import { describe, expect, it } from "vitest";
import {
  searchCredentialPublicSchema,
  searchCredentialUpsertSchema,
} from "./search-credentials.js";

describe("search credentials DTO", () => {
  it("requires a key and a cloud folder, with no extra fields", () => {
    expect(
      searchCredentialUpsertSchema.parse({ apiKey: "test-api-key", folderId: "b1g_123" }),
    ).toEqual({
      apiKey: "test-api-key",
      folderId: "b1g_123",
    });
    expect(() =>
      searchCredentialUpsertSchema.parse({ apiKey: "short", folderId: "b1g_123" }),
    ).toThrow();
    expect(() =>
      searchCredentialUpsertSchema.parse({ apiKey: "test-api-key", folderId: "bad id" }),
    ).toThrow();
    expect(() =>
      searchCredentialUpsertSchema.parse({ apiKey: "test-api-key", folderId: "a".repeat(51) }),
    ).toThrow();
    expect(() =>
      searchCredentialUpsertSchema.parse({
        apiKey: "test-api-key",
        folderId: "b1g_123",
        enabled: true,
      }),
    ).toThrow();
  });

  it("the public view cannot contain a key", () => {
    expect(
      searchCredentialPublicSchema.parse({ configured: false, folderId: null, updatedAt: null }),
    ).toEqual({
      configured: false,
      folderId: null,
      updatedAt: null,
    });
    expect(() =>
      searchCredentialPublicSchema.parse({
        configured: true,
        folderId: "b1g_123",
        updatedAt: "2026-09-25T00:00:00.000Z",
        apiKey: "secret",
      }),
    ).toThrow();
  });
});
