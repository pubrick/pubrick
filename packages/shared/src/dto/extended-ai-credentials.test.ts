import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_MODELS } from "../ai-text-selection.js";
import { aiCredentialUpsertSchema, parseProviderAiCredential } from "./ai-credentials.js";

const account = {
  type: "service_account",
  project_id: "fixture-project",
  private_key_id: "fixture-key-id",
  private_key: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
  client_email: "fixture@fixture-project.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
};

describe("explicit Vertex and compatible credentials", () => {
  it.each(["AQ.explicit-fixture-key", "AIza.explicit-fixture-key"])(
    "keeps Express keys opaque and does not route by prefix (%s)",
    (apiKey) => {
      expect(
        aiCredentialUpsertSchema.parse({ provider: "vertex", authMode: "express", apiKey }),
      ).toMatchObject({ provider: "vertex", authMode: "express", apiKey });
    },
  );

  it("accepts an explicit account and verified global/us/eu locations", () => {
    for (const location of ["global", "us", "eu"])
      expect(
        aiCredentialUpsertSchema.safeParse({
          provider: "vertex",
          authMode: "service_account",
          project: "fixture-project",
          location,
          serviceAccount: account,
        }).success,
      ).toBe(true);
  });

  it.each([
    { serviceAccount: { ...account, token_uri: "https://attacker.example/token" } },
    { serviceAccount: { ...account, type: "external_account" } },
    { serviceAccount: { ...account, universe_domain: "attacker.example" } },
    { location: "invented-region" },
    { project: "../other-project" },
    { serviceAccount: { ...account, credential_source: { file: "/operator/key" } } },
  ])("rejects ambient/external auth and destination overrides", (override) => {
    expect(
      aiCredentialUpsertSchema.safeParse({
        provider: "vertex",
        authMode: "service_account",
        project: "fixture-project",
        location: "global",
        serviceAccount: account,
        ...override,
      }).success,
    ).toBe(false);
  });

  it("requires custom endpoint identity but never invents its model", () => {
    expect(
      aiCredentialUpsertSchema.parse({
        provider: "openai_compatible",
        apiKey: "fixture-secret",
        baseURL: "https://llm.example/v1",
      }),
    ).toMatchObject({ baseURL: "https://llm.example/v1" });
    expect(DEFAULT_TEXT_MODELS.openai_compatible).toBeNull();
    expect(
      aiCredentialUpsertSchema.safeParse({
        provider: "openai_compatible",
        apiKey: "fixture-secret",
      }).success,
    ).toBe(false);
  });

  it.each([
    "http://llm.example/v1",
    "https://user:secret@llm.example/v1",
    "https://llm.example/v1?secret=value",
    "https://llm.example/v1#fragment",
    "https://llm.example/v1/%2e%2e/admin",
    "https://llm.example/v1/../admin",
  ])("rejects ambiguous or credential-bearing endpoint syntax: %s", (baseURL) => {
    expect(
      aiCredentialUpsertSchema.safeParse({
        provider: "openai_compatible",
        apiKey: "fixture-secret",
        baseURL,
      }).success,
    ).toBe(false);
  });

  it("parses stored secrets against their provider and never turns account auth into API-key auth", () => {
    expect(
      parseProviderAiCredential("vertex", {
        authMode: "service_account",
        project: "fixture-project",
        location: "global",
        serviceAccount: account,
      }),
    ).toMatchObject({ provider: "vertex", authMode: "service_account" });
    expect(() =>
      parseProviderAiCredential("google", { authMode: "service_account", serviceAccount: account }),
    ).toThrow();
    expect(() => parseProviderAiCredential("vertex", { apiKey: "fixture-secret" })).toThrow();
  });
});
