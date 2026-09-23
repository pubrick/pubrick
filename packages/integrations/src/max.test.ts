import { describe, expect, it, vi } from "vitest";
import { maxPublisher } from "./max.js";
import {
  PermanentPublishError,
  PlatformRejectionError,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";

const credentials = { accessToken: "max-secret-token", chatId: "-12345" };
const options = (fetchImpl: typeof fetch) => ({ fetchImpl, baseUrl: "https://max.test" });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("MAX publishing", () => {
  it("sends plain text with header auth and preserves the public post URL", async () => {
    const fetchImpl = vi.fn(async () =>
      answer({ message: { body: { mid: "post_7" }, url: "https://max.ru/c/7" } }),
    ) as unknown as typeof fetch;
    await expect(
      maxPublisher.publish(credentials, { text: "Hello <MAX>" }, options(fetchImpl)),
    ).resolves.toEqual({ externalId: "post_7", externalUrl: "https://max.ru/c/7" });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://max.test/messages?chat_id=-12345&disable_link_preview=true");
    expect(init?.headers).toMatchObject({ Authorization: credentials.accessToken });
    expect(JSON.parse(String(init?.body))).toEqual({ text: "Hello <MAX>" });
    expect(String(url)).not.toContain(credentials.accessToken);
  });

  it("does not retry an accepted post with an unusable receipt or truncate text", async () => {
    const fetchImpl = vi.fn(async () =>
      answer({ message: { body: {} } }),
    ) as unknown as typeof fetch;
    await expect(
      maxPublisher.publish(credentials, { text: "Hello" }, options(fetchImpl)),
    ).resolves.toEqual({ externalId: null, externalUrl: null });
    await expect(
      maxPublisher.publish(
        credentials,
        { text: "x".repeat(maxPublisher.maxTextLength + 1) },
        options(fetchImpl),
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("separates platform refusal, rate limit, and uncertain gateway response", async () => {
    const denied = vi.fn(async () =>
      answer({ code: "access_denied", message: "Cannot post" }, 403),
    ) as unknown as typeof fetch;
    await expect(
      maxPublisher.publish(credentials, { text: "Hi" }, options(denied)),
    ).rejects.toBeInstanceOf(PlatformRejectionError);
    const limited = vi.fn(async () =>
      answer({ code: "rate_limit", message: "Wait" }, 429),
    ) as unknown as typeof fetch;
    await expect(
      maxPublisher.publish(credentials, { text: "Hi" }, options(limited)),
    ).rejects.toBeInstanceOf(TransientPublishError);
    const gateway = vi.fn(
      async () => new Response("gateway", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      maxPublisher.publish(credentials, { text: "Hi" }, options(gateway)),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  it("redacts a token echoed in a platform error", async () => {
    const fetchImpl = vi.fn(async () =>
      answer({ code: "bad_token", message: `Credential ${credentials.accessToken}` }, 401),
    ) as unknown as typeof fetch;
    const error = await maxPublisher
      .publish(credentials, { text: "Hi" }, options(fetchImpl))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformRejectionError);
    expect((error as Error).message).not.toContain(credentials.accessToken);
  });
});

describe("MAX connection test", () => {
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === "/me") return answer({ user_id: 7, username: "writer_bot" });
    if (path === "/chats/-12345")
      return answer({ chat_id: -12345, type: "channel", status: "active", title: "Bakery" });
    return answer({ is_owner: false, is_admin: true, permissions: ["write"] });
  }) as unknown as typeof fetch;

  it("checks bot, destination, and write permission without sending", async () => {
    await expect(maxPublisher.verify(credentials, options(fetchImpl))).resolves.toEqual({
      ok: true,
      account: "@writer_bot",
      target: "Bakery",
    });
  });

  it("refuses an admin without write permission", async () => {
    const noWrite = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/me") return answer({ user_id: 7, username: "writer_bot" });
      if (path === "/chats/-12345")
        return answer({ chat_id: -12345, type: "channel", status: "active", title: "Bakery" });
      return answer({ is_owner: false, is_admin: true, permissions: ["read_all_messages"] });
    }) as unknown as typeof fetch;
    await expect(maxPublisher.verify(credentials, options(noWrite))).resolves.toEqual({
      ok: false,
      reason: "The MAX bot needs permission to post to this chat",
    });
  });
});
