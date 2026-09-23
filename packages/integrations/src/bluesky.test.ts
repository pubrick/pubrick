import { describe, expect, it, vi } from "vitest";
import { blueskyPublisher } from "./bluesky.js";
import {
  PermanentPublishError,
  PlatformRejectionError,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";

const credentials = { handle: "writer.bsky.social", appPassword: "secret-app-password" };
const did = "did:plc:abcdefghijklmnopqrstuvwx";
const jwt = "secret-session-token";
const session = { did, handle: credentials.handle, accessJwt: jwt };
const uri = `at://${did}/app.bsky.feed.post/3l5fabc`;
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const options = (fetchImpl: typeof fetch) => ({ fetchImpl });
const jpeg = Uint8Array.of(0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9);

describe("Bluesky publishing", () => {
  it("logs in with the handle/app password and creates exactly one text record", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new URL(String(url)).origin).toBe("https://bsky.social");
      expect(init?.redirect).toBe("error");
      if (String(url).endsWith("createSession")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          identifier: credentials.handle,
          password: credentials.appPassword,
        });
        expect(init?.headers).not.toHaveProperty("Authorization");
        return answer(session);
      }
      expect(String(url)).toBe("https://bsky.social/xrpc/com.atproto.repo.createRecord");
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      });
      const payload = JSON.parse(String(init?.body));
      expect(payload.repo).toBe(did);
      expect(payload.collection).toBe("app.bsky.feed.post");
      expect(payload.record).toMatchObject({ $type: "app.bsky.feed.post", text: "Reviewed post" });
      expect(payload.record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(payload.record).not.toHaveProperty("embed");
      return answer({ uri, cid: "bafy123" });
    }) as unknown as typeof fetch;
    await expect(
      blueskyPublisher.publish(credentials, { text: "Reviewed post" }, options(fetchImpl)),
    ).resolves.toEqual({
      externalId: uri,
      externalUrl: `https://bsky.app/profile/${did}/post/3l5fabc`,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uploads one JPEG blob before creating a post with an image embed", async () => {
    const blob = {
      $type: "blob",
      ref: { $link: "bafkreicover" },
      mimeType: "image/jpeg",
      size: jpeg.length,
    };
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("createSession")) return answer(session);
      if (path.endsWith("uploadBlob")) {
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${jwt}`,
          "content-type": "image/jpeg",
        });
        expect(init?.body).toEqual(jpeg);
        return answer({ blob });
      }
      const record = JSON.parse(String(init?.body)).record;
      expect(record.embed).toEqual({
        $type: "app.bsky.embed.images",
        images: [{ alt: "Post cover image", image: blob }],
      });
      return answer({ uri });
    }) as unknown as typeof fetch;
    await expect(
      blueskyPublisher.publish(
        credentials,
        { text: "Cover", image: { bytes: jpeg, mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).resolves.toMatchObject({ externalId: uri });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("verifies the account with a session only", async () => {
    const fetchImpl = vi.fn(async () => answer(session)) as unknown as typeof fetch;
    await expect(blueskyPublisher.verify(credentials, options(fetchImpl))).resolves.toEqual({
      ok: true,
      account: "@writer.bsky.social",
      target: "@writer.bsky.social",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toContain("createSession");
  });

  it("rejects arbitrary PDS URLs and invalid text or image before any network call", async () => {
    const fetchImpl = vi.fn(async () => answer(session)) as unknown as typeof fetch;
    await expect(
      blueskyPublisher.publish(
        credentials,
        { text: "Hello" },
        {
          fetchImpl,
          baseUrl: "https://127.0.0.1",
        },
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    await expect(
      blueskyPublisher.publish(credentials, { text: "" }, options(fetchImpl)),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    await expect(
      blueskyPublisher.publish(credentials, { text: "x".repeat(301) }, options(fetchImpl)),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    await expect(
      blueskyPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: Uint8Array.of(1), mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("counts grapheme clusters instead of UTF-16 units", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("createSession") ? answer(session) : answer({ uri }),
    ) as unknown as typeof fetch;
    await expect(
      blueskyPublisher.publish(credentials, { text: "🧑‍💻".repeat(300) }, options(fetchImpl)),
    ).resolves.toMatchObject({ externalId: uri });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies a structured 400 post refusal and redacts credentials", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("createSession")
        ? answer(session)
        : answer(
            { error: "InvalidRequest", message: `Rejected ${credentials.appPassword} ${jwt}` },
            400,
          ),
    ) as unknown as typeof fetch;
    const error = await blueskyPublisher
      .publish(credentials, { text: "Hello" }, options(fetchImpl))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformRejectionError);
    expect((error as Error).message).not.toContain(credentials.appPassword);
    expect((error as Error).message).not.toContain(jwt);
  });

  it("treats an explicit 429 refusal as retryable and an ambiguous 5xx as unknown", async () => {
    for (const [status, expected] of [
      [429, TransientPublishError],
      [502, UnknownOutcomePublishError],
    ] as const) {
      const fetchImpl = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("createSession")
          ? answer(session)
          : answer({ error: "RateLimitExceeded", message: "Try later" }, status),
      ) as unknown as typeof fetch;
      await expect(
        blueskyPublisher.publish(credentials, { text: "Hello" }, options(fetchImpl)),
      ).rejects.toBeInstanceOf(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("never retries an accepted post with a malformed receipt", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("createSession") ? answer(session) : answer({ uri: "wrong" }),
    ) as unknown as typeof fetch;
    await expect(
      blueskyPublisher.publish(credentials, { text: "Hello" }, options(fetchImpl)),
    ).resolves.toEqual({ externalId: null, externalUrl: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a post socket reset as unknown but a connect failure as retryable", async () => {
    const reset = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("createSession")) return answer(session);
      throw new Error(`socket reset ${jwt}`);
    }) as unknown as typeof fetch;
    const unknown = await blueskyPublisher
      .publish(credentials, { text: "Hello" }, options(reset))
      .catch((caught: unknown) => caught);
    expect(unknown).toBeInstanceOf(UnknownOutcomePublishError);
    expect((unknown as Error).message).not.toContain(jwt);

    const refused = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("createSession")) return answer(session);
      throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    }) as unknown as typeof fetch;
    await expect(
      blueskyPublisher.publish(credentials, { text: "Hello" }, options(refused)),
    ).rejects.toBeInstanceOf(TransientPublishError);
  });

  it("treats an unreadable createRecord response as an unknown post outcome", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("createSession")
        ? answer(session)
        : new Response("<html>gateway</html>", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      blueskyPublisher.publish(credentials, { text: "Hello" }, options(fetchImpl)),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  it("keeps an upload failure retryable because no post exists", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("createSession")
        ? answer(session)
        : new Response("gateway", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(
      blueskyPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: jpeg, mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).rejects.toBeInstanceOf(TransientPublishError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns a safe connection refusal without exposing the app password", async () => {
    const fetchImpl = vi.fn(async () =>
      answer(
        { error: "AuthenticationRequired", message: `Bad password: ${credentials.appPassword}` },
        401,
      ),
    ) as unknown as typeof fetch;
    const result = await blueskyPublisher.verify(credentials, options(fetchImpl));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain(credentials.appPassword);
  });
});
