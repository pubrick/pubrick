import { generateKeyPairSync } from "node:crypto";
import { AiTextSelectionChangedError } from "@pubrick/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runFailureOf } from "./classify.js";
import { generateStructured } from "./generate.js";
import * as googleTransport from "./google-transport.js";
import { resolveModel } from "./provider.js";
import type { UsageRecord } from "./usage.js";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const serviceAccount = {
  type: "service_account" as const,
  project_id: "fixture-project",
  private_key_id: "fixture-id",
  private_key: privateKey,
  client_email: "fixture@fixture-project.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token" as const,
};
const reply = () =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: '{"headline":"Hello"}' }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
    { headers: { "content-type": "application/json" } },
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("workspace Vertex BYOK", () => {
  it.each(["AQ.explicit-fixture", "AIza.explicit-fixture"])(
    "uses Express key %s without ADC",
    async (apiKey) => {
      vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/must-not-read");
      vi.stubEnv("GOOGLE_VERTEX_API_KEY", "operator-must-not-bill");
      const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => reply());
      vi.stubGlobal("fetch", fetch);
      const model = resolveModel({ provider: "vertex", authMode: "express", apiKey });
      expect(
        await generateStructured({
          model,
          provider: "vertex",
          schema: z.object({ headline: z.string() }),
          instructions: "JSON",
          prompt: "Hello",
          maxRetries: 0,
          onUsage: () => {},
        }),
      ).toEqual({ headline: "Hello" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]?.[0])).toBe(
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent",
      );
      const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
      expect(headers.get("x-goog-api-key")).toBe(apiKey);
      expect(headers.get("authorization")).toBeNull();
    },
  );

  it("exchanges a native signed JWT at fixed OAuth URL and suppresses both ambient API-key factories", async () => {
    vi.stubEnv("GOOGLE_VERTEX_API_KEY", "operator-must-not-bill");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "operator-project");
    vi.stubEnv("GOOGLE_VERTEX_LOCATION", "operator-region");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/must-not-read");
    vi.stubEnv("GOOGLE_API_PROXY", "http://operator-proxy.invalid:8080");
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === serviceAccount.token_uri
        ? new Response(
            JSON.stringify({
              access_token: "fixture-access-token",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { headers: { "content-type": "application/json" } },
          )
        : reply(),
    );
    vi.stubGlobal("fetch", fetch);
    const records: UsageRecord[] = [];
    const model = resolveModel({
      provider: "vertex",
      authMode: "service_account",
      project: "fixture-project",
      location: "global",
      serviceAccount,
    });
    await generateStructured({
      model,
      provider: "vertex",
      schema: z.object({ headline: z.string() }),
      instructions: "JSON",
      prompt: "Hello",
      maxRetries: 0,
      onUsage: (row) => {
        records.push(row);
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [tokenURL, tokenInit] = fetch.mock.calls[0] ?? [];
    expect(String(tokenURL)).toBe(serviceAccount.token_uri);
    expect(tokenInit?.redirect).toBe("manual");
    const assertion = new URLSearchParams(String(tokenInit?.body)).get("assertion");
    expect(assertion).toBeTruthy();
    const claims = JSON.parse(Buffer.from(assertion?.split(".")[1] ?? "", "base64url").toString());
    expect(claims).toMatchObject({
      iss: serviceAccount.client_email,
      aud: serviceAccount.token_uri,
      scope: "https://www.googleapis.com/auth/cloud-platform",
    });
    const [modelURL, modelInit] = fetch.mock.calls[1] ?? [];
    expect(String(modelURL)).toBe(
      "https://aiplatform.googleapis.com/v1beta1/projects/fixture-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent",
    );
    expect(new Headers(modelInit?.headers).get("authorization")).toBe(
      "Bearer fixture-access-token",
    );
    expect(new Headers(modelInit?.headers).get("x-goog-api-key")).toBeNull();
    expect(records).toHaveLength(1);
    expect(records[0]?.costSource).toBe("unknown");
  });

  it("reports model permission refusal after successful OAuth without blaming the service-account key", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === serviceAccount.token_uri
        ? new Response(
            JSON.stringify({
              access_token: "fixture-access-token",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { headers: { "content-type": "application/json" } },
          )
        : new Response(
            JSON.stringify({
              error: {
                code: 403,
                status: "PERMISSION_DENIED",
                message: "Permission aiplatform.endpoints.predict denied",
              },
            }),
            { status: 403, headers: { "content-type": "application/json" } },
          ),
    );
    vi.stubGlobal("fetch", fetch);
    const model = resolveModel({
      provider: "vertex",
      authMode: "service_account",
      project: "fixture-project",
      location: "global",
      serviceAccount,
    });
    const records: UsageRecord[] = [];
    const error = await generateStructured({
      model,
      provider: "vertex",
      schema: z.object({ headline: z.string() }),
      instructions: "JSON",
      prompt: "Hello",
      maxRetries: 0,
      onUsage: (record) => {
        records.push(record);
      },
    }).catch((value) => value);
    expect(runFailureOf(error)).toBe("provider_refused");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(serviceAccount.token_uri);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "vertex",
      outcome: "errored",
      costUsd: null,
      costSource: "unknown",
    });
  });

  it("binds only the explicit Vertex proxy to both OAuth and model endpoints", async () => {
    vi.stubEnv("GOOGLE_API_PROXY", "http://other-provider-proxy.invalid:8080");
    const vertexProxy = "http://vertex-user:vertex-password@8.8.8.8:8080";
    const proxy = vi.spyOn(googleTransport, "googleProxyFetch").mockImplementation(async (input) =>
      String(input) === serviceAccount.token_uri
        ? new Response(
            JSON.stringify({
              access_token: "fixture-access-token",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { headers: { "content-type": "application/json" } },
          )
        : reply(),
    );
    const direct = vi.fn(async () => {
      throw new Error("Must use explicit proxy");
    });
    vi.stubGlobal("fetch", direct);
    const model = resolveModel({
      provider: "vertex",
      authMode: "service_account",
      project: "fixture-project",
      location: "global",
      serviceAccount,
      proxyUrl: vertexProxy,
    });
    await generateStructured({
      model,
      provider: "vertex",
      schema: z.object({ headline: z.string() }),
      instructions: "JSON",
      prompt: "Hello",
      maxRetries: 0,
      onUsage: () => {},
    });
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy.mock.calls.map((call) => call[2])).toEqual([vertexProxy, vertexProxy]);
    expect(direct).not.toHaveBeenCalled();
    proxy.mockRestore();
  });

  it.each([
    [400, "invalid_key"],
    [401, "invalid_key"],
    [403, "provider_refused"],
  ] as const)(
    "records no model call for OAuth %i without leaking its body: %s",
    async (status, reason) => {
      const fetch = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ error: "invalid_grant", error_description: privateKey }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const records: UsageRecord[] = [];
      const model = resolveModel({
        provider: "vertex",
        authMode: "service_account",
        project: "fixture-project",
        location: "global",
        serviceAccount,
      });
      const error = await generateStructured({
        model,
        provider: "vertex",
        schema: z.object({ headline: z.string() }),
        instructions: "JSON",
        prompt: "Hello",
        maxRetries: 0,
        onUsage: (row) => {
          records.push(row);
        },
      }).catch((error) => error);
      expect(runFailureOf(error)).toBe(reason);
      expect(String(error)).not.toContain("BEGIN PRIVATE KEY");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(records).toEqual([]);
    },
  );

  it("retains the real failed HTTP receipt but refuses a new attempt after rotation", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"error":{"message":"Busy"}}', {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    let admitted = 0;
    const records: UsageRecord[] = [];
    const model = resolveModel({
      provider: "vertex",
      authMode: "express",
      apiKey: "fixture-key",
      admitCall: async () => {
        if (++admitted > 1) throw new AiTextSelectionChangedError();
      },
    });
    const error = await generateStructured({
      model,
      provider: "vertex",
      schema: z.object({ headline: z.string() }),
      instructions: "JSON",
      prompt: "Hello",
      maxRetries: 1,
      onUsage: (row) => {
        records.push(row);
      },
    }).catch((error) => error);
    expect(runFailureOf(error)).toBe("configuration_changed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(admitted).toBe(2);
    expect(records).toHaveLength(1);
  });
});
