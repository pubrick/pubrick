import { describe, expect, it, vi } from "vitest";
import {
  PermanentPublishError,
  PlatformRejectionError,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";
import { readVkPostMetrics, vkPublisher } from "./vk.js";

const credentials = { accessToken: "vk-secret-token", groupId: "12345" };
const options = (fetchImpl: typeof fetch) => ({ fetchImpl, baseUrl: "https://vk.test/method" });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("VK publishing", () => {
  it("uploads one JPEG to the community wall and attaches the saved photo to the post", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("account.getAppPermissions")) return answer({ response: 8196 });
      if (target.endsWith("photos.getWallUploadServer")) {
        expect(new URLSearchParams(String(init?.body)).get("group_id")).toBe("12345");
        return answer({ response: { upload_url: "https://pu.vk.com/upload.php?key=capability" } });
      }
      if (target.startsWith("https://pu.vk.com/")) {
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(init?.body).toBeInstanceOf(FormData);
        if (!(init?.body instanceof FormData)) throw new Error("Expected multipart upload");
        const file = init.body.get("photo") as File;
        expect(file.type).toBe("image/jpeg");
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
        return answer({ server: 42, photo: "photo-token", hash: "hash-token" });
      }
      if (target.endsWith("photos.saveWallPhoto")) {
        const body = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(body)).toMatchObject({
          group_id: "12345",
          server: "42",
          photo: "photo-token",
          hash: "hash-token",
        });
        return answer({ response: [{ owner_id: -12345, id: 17 }] });
      }
      expect(target).toBe("https://vk.test/method/wall.post");
      expect(new URLSearchParams(String(init?.body)).get("attachments")).toBe("photo-12345_17");
      return answer({ response: { post_id: 89 } });
    }) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes, mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).resolves.toEqual({ externalId: "89", externalUrl: "https://vk.com/wall-12345_89" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("refuses an untrusted upload URL before sending the cover anywhere", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("account.getAppPermissions")
        ? answer({ response: 8196 })
        : answer({ response: { upload_url: "http://127.0.0.1/internal" } }),
    ) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: Uint8Array.of(1), mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries an uncertain photo preparation, but never an uncertain wall post", async () => {
    const uploadLost = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("account.getAppPermissions")) return answer({ response: 8196 });
      if (String(url).endsWith("photos.getWallUploadServer")) {
        return answer({ response: { upload_url: "https://pu.vk.com/upload.php" } });
      }
      throw new Error("upload socket lost");
    }) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: Uint8Array.of(1), mimeType: "image/jpeg" } },
        options(uploadLost),
      ),
    ).rejects.toBeInstanceOf(TransientPublishError);
    expect(uploadLost).toHaveBeenCalledTimes(3);

    const postLost = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("account.getAppPermissions")) return answer({ response: 8196 });
      if (target.endsWith("photos.getWallUploadServer")) {
        return answer({ response: { upload_url: "https://pu.vk.com/upload.php" } });
      }
      if (target.startsWith("https://pu.vk.com/")) {
        return answer({ server: 42, photo: "photo", hash: "hash" });
      }
      if (target.endsWith("photos.saveWallPhoto")) {
        return answer({ response: [{ owner_id: -12345, id: 17 }] });
      }
      throw new Error("wall response lost");
    }) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: Uint8Array.of(1), mimeType: "image/jpeg" } },
        options(postLost),
      ),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
    expect(postLost).toHaveBeenCalledTimes(5);
  });

  it("never posts when VK saves the photo outside the selected community", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("account.getAppPermissions")) return answer({ response: 8196 });
      if (target.endsWith("photos.getWallUploadServer")) {
        return answer({ response: { upload_url: "https://pu.vk.com/upload.php" } });
      }
      if (target.startsWith("https://pu.vk.com/")) {
        return answer({ server: 42, photo: "photo", hash: "hash" });
      }
      return answer({ response: [{ owner_id: -999, id: 17 }] });
    }) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: Uint8Array.of(1), mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("treats a plain HTTP 413 upload refusal as permanent before wall.post", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("account.getAppPermissions")) return answer({ response: 8196 });
      if (String(url).endsWith("photos.getWallUploadServer")) {
        return answer({ response: { upload_url: "https://pu.vk.com/upload.php" } });
      }
      return new Response("too large", { status: 413 });
    }) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: Uint8Array.of(1), mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects a cover before upload when the user token lacks photos permission", async () => {
    const fetchImpl = vi.fn(async () => answer({ response: 8192 })) as unknown as typeof fetch;
    await expect(
      vkPublisher.publish(
        credentials,
        { text: "Hello", image: { bytes: Uint8Array.of(1), mimeType: "image/jpeg" } },
        options(fetchImpl),
      ),
    ).rejects.toThrow("wall and photos permissions for covers");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

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

describe("VK post metrics", () => {
  it("reads only the requested community post and preserves a measured zero", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe("https://vk.test/method/wall.getById");
      expect(String(init?.body)).toContain("posts=-12345_89");
      return answer({
        response: {
          items: [
            { owner_id: -9, id: 89, views: { count: 900 } },
            { owner_id: -12345, id: 89, views: { count: 0 }, likes: { count: 3 } },
          ],
        },
      });
    }) as unknown as typeof fetch;
    await expect(readVkPostMetrics(credentials, "89", options(fetchImpl))).resolves.toEqual({
      views: 0,
      likes: 3,
      comments: null,
      shares: null,
    });
  });

  it("leaves absent or mismatched posts unknown", async () => {
    const fetchImpl = vi.fn(async () =>
      answer({ response: { items: [] } }),
    ) as unknown as typeof fetch;
    await expect(readVkPostMetrics(credentials, "89", options(fetchImpl))).resolves.toBeNull();
    await expect(
      readVkPostMetrics(credentials, "not-an-id", options(fetchImpl)),
    ).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("VK connection test", () => {
  it("checks user identity, wall permission, and community administration", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "users.get") return answer({ response: [{ id: 7 }] });
      if (method === "account.getAppPermissions") return answer({ response: 8196 });
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

  it("keeps text-only channels connected when the user token lacks photos permission", async () => {
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

  it("refuses a user who does not administer the requested community", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "users.get") return answer({ response: [{ id: 7 }] });
      if (method === "account.getAppPermissions") return answer({ response: 8196 });
      return answer({ response: { groups: [{ id: 12345, name: "Another team", is_admin: 0 }] } });
    }) as unknown as typeof fetch;
    await expect(vkPublisher.verify(credentials, options(fetchImpl))).resolves.toEqual({
      ok: false,
      reason: "The connected user cannot administer Another team",
    });
  });
});
