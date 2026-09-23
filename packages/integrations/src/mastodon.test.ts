import { describe, expect, it, vi } from "vitest";
import { mastodonPublisher } from "./mastodon.js";
import {
  PermanentPublishError,
  PlatformRejectionError,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";

const credentials = {
  instanceUrl: "https://mastodon.social",
  accessToken: "mastodon-secret-token",
};
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const options = (fetchImpl: typeof fetch) => ({ fetchImpl });
const instance = { configuration: { statuses: { max_characters: 500 } } };

describe("Mastodon publishing", () => {
  it("verifies the token on the configured instance without posting", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://mastodon.social/api/v1/accounts/verify_credentials");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${credentials.accessToken}` });
      return answer({ id: "17", username: "writer" });
    }) as unknown as typeof fetch;
    await expect(mastodonPublisher.verify(credentials, options(fetchImpl))).resolves.toEqual({
      ok: true,
      account: "@writer@mastodon.social",
      target: "mastodon.social",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads the instance limit then publishes reviewed text as public", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/v2/instance")) return answer(instance);
      expect(String(url)).toBe("https://mastodon.social/api/v1/statuses");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${credentials.accessToken}`,
        "content-type": "application/x-www-form-urlencoded",
      });
      expect(new URLSearchParams(String(init?.body)).get("status")).toBe("Reviewed post <plain>");
      expect(new URLSearchParams(String(init?.body)).get("visibility")).toBe("public");
      expect(String(url)).not.toContain(credentials.accessToken);
      return answer({ id: "123", url: "https://mastodon.social/@writer/123" });
    }) as unknown as typeof fetch;
    await expect(
      mastodonPublisher.publish(credentials, { text: "Reviewed post <plain>" }, options(fetchImpl)),
    ).resolves.toEqual({ externalId: "123", externalUrl: "https://mastodon.social/@writer/123" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("supports explicit unlisted visibility", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/v2/instance")) return answer(instance);
      expect(new URLSearchParams(String(init?.body)).get("visibility")).toBe("unlisted");
      return answer({ id: "124", url: null });
    }) as unknown as typeof fetch;
    await expect(
      mastodonPublisher.publish(
        { ...credentials, visibility: "unlisted" },
        { text: "Quiet update" },
        options(fetchImpl),
      ),
    ).resolves.toEqual({ externalId: "124", externalUrl: null });
  });

  it("refuses instance URLs that could reach private or unexpected destinations", async () => {
    const fetchImpl = vi.fn(async () => answer(instance)) as unknown as typeof fetch;
    for (const instanceUrl of [
      "http://mastodon.social",
      "https://127.0.0.1",
      "https://2130706433",
      "https://[::1]",
      "https://localhost",
      "https://something.local",
      "https://user:secret@mastodon.social",
      "https://mastodon.social:8443",
      "https://mastodon.social/admin",
      "https://mastodon.social?next=internal",
    ]) {
      await expect(
        mastodonPublisher.publish(
          { ...credentials, instanceUrl },
          { text: "Hello" },
          options(fetchImpl),
        ),
      ).rejects.toBeInstanceOf(PermanentPublishError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a cover and a too-long post before any HTTP call", async () => {
    const fetchImpl = vi.fn(async () => answer(instance)) as unknown as typeof fetch;
    await expect(
      mastodonPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: Uint8Array.of(0xff), mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    await expect(
      mastodonPublisher.publish(credentials, { text: "x".repeat(501) }, options(fetchImpl)),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honors a lower instance limit without sending the status", async () => {
    const fetchImpl = vi.fn(async () =>
      answer({ configuration: { statuses: { max_characters: 10 } } }),
    ) as unknown as typeof fetch;
    await expect(
      mastodonPublisher.publish(credentials, { text: "eleven chars" }, options(fetchImpl)),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 2xx post with an unusable receipt or trust an off-instance URL", async () => {
    const malformed = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api/v2/instance") ? answer(instance) : answer({ id: null }),
    ) as unknown as typeof fetch;
    await expect(
      mastodonPublisher.publish(credentials, { text: "Hello" }, options(malformed)),
    ).resolves.toEqual({ externalId: null, externalUrl: null });
    expect(malformed).toHaveBeenCalledTimes(2);
    const offInstance = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api/v2/instance")
        ? answer(instance)
        : answer({ id: "55", url: "https://evil.example/status/55" }),
    ) as unknown as typeof fetch;
    await expect(
      mastodonPublisher.publish(credentials, { text: "Hello" }, options(offInstance)),
    ).resolves.toEqual({ externalId: "55", externalUrl: null });
    const malformedUrl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api/v2/instance")
        ? answer(instance)
        : answer({ id: "56", url: "not a URL" }),
    ) as unknown as typeof fetch;
    await expect(
      mastodonPublisher.publish(credentials, { text: "Hello" }, options(malformedUrl)),
    ).resolves.toEqual({ externalId: "56", externalUrl: null });
  });

  it("separates provider refusal, rate limit, and unknown gateway outcome", async () => {
    for (const [status, expected] of [
      [422, PlatformRejectionError],
      [429, TransientPublishError],
      [502, UnknownOutcomePublishError],
    ] as const) {
      const fetchImpl = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/api/v2/instance")
          ? answer(instance)
          : answer({ error: "Rejected" }, status),
      ) as unknown as typeof fetch;
      await expect(
        mastodonPublisher.publish(credentials, { text: "Hello" }, options(fetchImpl)),
      ).rejects.toBeInstanceOf(expected);
    }
  });

  it("treats non-Mastodon 4xx responses after a status send as unknown", async () => {
    for (const status of [403, 429]) {
      const fetchImpl = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/api/v2/instance")
          ? answer(instance)
          : new Response("gateway response", { status }),
      ) as unknown as typeof fetch;
      await expect(
        mastodonPublisher.publish(credentials, { text: "Hello" }, options(fetchImpl)),
      ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
    }
  });

  it("does not leak an access token echoed by the server", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api/v2/instance")
        ? answer(instance)
        : answer({ error: `Invalid ${credentials.accessToken}` }, 401),
    ) as unknown as typeof fetch;
    const error = await mastodonPublisher
      .publish(credentials, { text: "Hello" }, options(fetchImpl))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformRejectionError);
    expect((error as Error).message).not.toContain(credentials.accessToken);
  });

  it("classifies a status socket reset as unknown, but a connection refusal as transient", async () => {
    const lost = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/v2/instance")) return answer(instance);
      throw new Error(`Socket reset ${credentials.accessToken}`);
    }) as unknown as typeof fetch;
    const unknown = await mastodonPublisher
      .publish(credentials, { text: "Hello" }, options(lost))
      .catch((caught: unknown) => caught);
    expect(unknown).toBeInstanceOf(UnknownOutcomePublishError);
    expect((unknown as Error).message).not.toContain(credentials.accessToken);

    const refused = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/v2/instance")) return answer(instance);
      throw Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;
    await expect(
      mastodonPublisher.publish(credentials, { text: "Hello" }, options(refused)),
    ).rejects.toBeInstanceOf(TransientPublishError);
  });
});
