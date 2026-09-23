import { describe, expect, it, vi } from "vitest";
import {
  PermanentPublishError,
  PlatformRejectionError,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";
import { vkPublisher } from "./vk.js";

const credentials = { accessToken: "vk-secret-token", groupId: "12345" };
const options = (fetchImpl: typeof fetch) => ({ fetchImpl, baseUrl: "https://vk.test/method" });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("VK publishing", () => {
  it("posts exact text as the community and returns its wall URL", async () => {
    const fetchImpl = vi.fn(async () =>
      answer({ response: { post_id: 89 } }),
    ) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(credentials, { text: "Hello & <VK>" }, options(fetchImpl)),
    ).resolves.toEqual({ externalId: "89", externalUrl: "https://vk.com/wall-12345_89" });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://vk.test/method/wall.post");
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({
      owner_id: "-12345",
      from_group: "1",
      message: "Hello & <VK>",
      access_token: credentials.accessToken,
      v: "5.199",
    });
  });

  it("never silently truncates, and never retries a successful post with a malformed id", async () => {
    const fetchImpl = vi.fn(async () =>
      answer({ response: { post_id: "bad" } }),
    ) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(credentials, { text: "Hello" }, options(fetchImpl)),
    ).resolves.toEqual({ externalId: null, externalUrl: null });
    await expect(
      vkPublisher.publish(
        credentials,
        { text: "x".repeat(vkPublisher.maxTextLength + 1) },
        options(fetchImpl),
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("classifies VK's own refusal, rate limit and an ambiguous gateway separately", async () => {
    const refusal = vi.fn(async () =>
      answer({ error: { error_code: 210, error_msg: "No access" } }),
    ) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(credentials, { text: "Hello" }, options(refusal)),
    ).rejects.toBeInstanceOf(PlatformRejectionError);

    const limited = vi.fn(async () =>
      answer({ error: { error_code: 6, error_msg: "Too many requests" } }),
    ) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(credentials, { text: "Hello" }, options(limited)),
    ).rejects.toBeInstanceOf(TransientPublishError);

    const gateway = vi.fn(
      async () => new Response("bad gateway", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(credentials, { text: "Hello" }, options(gateway)),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  it("redacts the token even when an upstream error echoes it", async () => {
    const fetchImpl = vi.fn(async () =>
      answer({
        error: { error_code: 5, error_msg: `Bad token ${credentials.accessToken}` },
      }),
    ) as unknown as typeof fetch;
    const error = await vkPublisher
      .publish(credentials, { text: "Hello" }, options(fetchImpl))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformRejectionError);
    expect((error as Error).message).not.toContain(credentials.accessToken);
  });
});

describe("VK connection test", () => {
  it("checks user identity, wall permission, and community administration", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "users.get") return answer({ response: [{ id: 7 }] });
      if (method === "account.getAppPermissions") return answer({ response: 8192 });
      return answer({ response: { groups: [{ id: 12345, name: "The bakery", is_admin: 1 }] } });
    }) as unknown as typeof fetch;
    await expect(vkPublisher.verify(credentials, options(fetchImpl))).resolves.toEqual({
      ok: true,
      account: "id7",
      target: "The bakery",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("refuses a token without wall permission before claiming it can post", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("users.get")) return answer({ response: [{ id: 7 }] });
      return answer({ response: 0 });
    }) as unknown as typeof fetch;
    await expect(vkPublisher.verify(credentials, options(fetchImpl))).resolves.toEqual({
      ok: false,
      reason: "The VK user token needs wall permission",
    });
  });

  it("refuses a user who does not administer the requested community", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "users.get") return answer({ response: [{ id: 7 }] });
      if (method === "account.getAppPermissions") return answer({ response: 8192 });
      return answer({ response: { groups: [{ id: 12345, name: "Another team", is_admin: 0 }] } });
    }) as unknown as typeof fetch;
    await expect(vkPublisher.verify(credentials, options(fetchImpl))).resolves.toEqual({
      ok: false,
      reason: "The connected user cannot administer Another team",
    });
  });
});
