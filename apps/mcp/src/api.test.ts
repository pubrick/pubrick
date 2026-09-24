import { describe, expect, it, vi } from "vitest";
import { createPublicContentClient, loadConfig, PublicApiError, validateBaseUrl } from "./api.js";

const id = "90ebcfc4-e20a-4b03-8501-0e883767a137";
const brandId = "0d139af6-c7a0-46f8-bfb7-b4111d8c3121";
const key = "pbrk_private_test_key";
const summary = {
  id,
  brandId,
  title: "A title",
  status: "draft",
  origin: "human",
  createdAt: "2026-09-24T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("public content API client", () => {
  it("sends only Bearer-authenticated GETs, carries the cursor, and strips unknown fields", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse([{ ...summary, internalNote: "do not expose" }], {
        headers: { "content-type": "application/json", "x-next-cursor": "opaque+cursor==" },
      }),
    );
    const client = createPublicContentClient(
      { baseUrl: validateBaseUrl("https://pubrick.example/team/"), apiKey: key },
      fetcher,
    );
    const page = await client.list({ status: "draft", limit: 1, cursor: "before:opaque" });

    expect(page).toEqual({ items: [summary], nextCursor: "opaque+cursor==" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://pubrick.example/team/api/v1/content?status=draft&limit=1&cursor=before%3Aopaque",
    );
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
  });

  it("reads detail through the fixed endpoint and returns only documented fields", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ...summary, body: "The public body", prompt: "secret" }),
    );
    const client = createPublicContentClient(
      { baseUrl: validateBaseUrl("http://127.0.0.1:3001"), apiKey: key },
      fetcher,
    );
    expect(await client.get(id)).toEqual({ ...summary, body: "The public body" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:3001/api/v1/content/${id}`);
  });

  it("keeps the API key and untrusted response bodies out of tool-facing errors", async () => {
    const config = { baseUrl: validateBaseUrl("https://pubrick.example"), apiKey: key };
    const denied = createPublicContentClient(config, async () =>
      jsonResponse({ message: `Invalid ${key}` }, { status: 401 }),
    );
    await expect(denied.list()).rejects.toThrow("Pubrick denied the API key");

    const failed = createPublicContentClient(config, async () => {
      throw new Error(`Network failure for ${key}`);
    });
    await expect(failed.get(id)).rejects.toThrow("Could not reach Pubrick");

    for (const client of [denied, failed]) {
      try {
        await client.get(id);
      } catch (error) {
        expect(String(error)).not.toContain(key);
      }
    }
  });

  it("rejects oversized, malformed, and unexpected responses before relaying them", async () => {
    const config = { baseUrl: validateBaseUrl("https://pubrick.example"), apiKey: key };
    const oversized = createPublicContentClient(config, async () =>
      jsonResponse("x".repeat(2 * 1024 * 1024 + 1)),
    );
    await expect(oversized.get(id)).rejects.toThrow("too large");

    const malformed = createPublicContentClient(config, async () =>
      jsonResponse({ ...summary, body: 42 }),
    );
    await expect(malformed.get(id)).rejects.toThrow("invalid content item");

    const redirect = createPublicContentClient(config, async (_url, init) => {
      expect(init?.redirect).toBe("error");
      throw new Error("redirect refused");
    });
    await expect(redirect.list()).rejects.toThrow("Could not reach Pubrick");
  });
});

describe("configuration", () => {
  it("accepts HTTPS and literal loopback HTTP, but rejects remote plaintext and URL credentials", () => {
    expect(validateBaseUrl("https://pubrick.example").href).toBe("https://pubrick.example/");
    expect(validateBaseUrl("http://localhost:3001").href).toBe("http://localhost:3001/");
    expect(validateBaseUrl("http://[::1]:3001").href).toBe("http://[::1]:3001/");
    for (const url of [
      "http://pubrick.example",
      "https://user:password@pubrick.example",
      "https://pubrick.example/?token=secret",
      "file:///tmp/private",
    ]) {
      expect(() => validateBaseUrl(url)).toThrow(PublicApiError);
    }
  });

  it("requires an environment key without leaking it in a configuration error", () => {
    expect(() => loadConfig({ PUBRICK_API_BASE_URL: "https://pubrick.example" })).toThrow(
      "PUBRICK_API_KEY is required",
    );
    expect(() =>
      loadConfig({ PUBRICK_API_BASE_URL: "https://pubrick.example", PUBRICK_API_KEY: `${key}\n` }),
    ).toThrow("PUBRICK_API_KEY is required");
  });
});
