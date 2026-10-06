import { GuardedFetchError, GuardedFetchErrorCode, guardedFetch } from "guarded-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  PlatformRejectionError,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";
import { WORDPRESS_REQUEST_TIMEOUT_MS, wordpressPublisher } from "./wordpress.js";

vi.mock("guarded-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("guarded-fetch")>()),
  guardedFetch: vi.fn(),
}));

const mockGuardedFetch = vi.mocked(guardedFetch);
const credentials = {
  siteUrl: "https://writer.pubrick.org/blog",
  username: "editor",
  applicationPassword: "abcd efgh ijkl mnop qrst uvwx",
};
const compactPassword = credentials.applicationPassword.replace(/\s/g, "");
const basicValue = Buffer.from(`${credentials.username}:${compactPassword}`).toString("base64");
const account = { id: 17, username: "editor", capabilities: { read: true, publish_posts: true } };
const receipt = {
  id: 123,
  status: "publish",
  link: "https://writer.pubrick.org/blog/reviewed-post/",
};
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const envelope = (status: number) => ({
  code: "rest_cannot_create",
  message: `Password ${credentials.applicationPassword}; Authorization Basic ${basicValue}`,
  data: { status },
});
const publish = (text = "Reviewed text") => wordpressPublisher.publish(credentials, { text });

beforeEach(() => {
  mockGuardedFetch.mockReset();
});

describe("WordPress connection verification", () => {
  it("checks publish_posts on the current user through the connected subdirectory without creating a post", async () => {
    mockGuardedFetch.mockResolvedValue(answer(account));
    await expect(wordpressPublisher.verify(credentials)).resolves.toEqual({
      ok: true,
      account: "editor",
      target: "https://writer.pubrick.org/blog/",
    });
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
    const [url, options] = mockGuardedFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://writer.pubrick.org/blog/wp-json/wp/v2/users/me?context=edit");
    expect(options).toEqual({
      method: "GET",
      headers: { Authorization: `Basic ${basicValue}`, Accept: "application/json" },
      body: undefined,
      httpsOnly: true,
      allowedHosts: ["writer.pubrick.org"],
      followRedirects: false,
      timeoutMs: WORDPRESS_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
    });
    expect(String(url)).not.toContain(compactPassword);
  });

  it.each([false, undefined])(
    "refuses identity-only success when publish_posts is %s",
    async (permission) => {
      mockGuardedFetch.mockResolvedValue(
        answer({
          ...account,
          capabilities: permission === undefined ? { read: true } : { publish_posts: permission },
        }),
      );
      await expect(wordpressPublisher.verify(credentials)).resolves.toEqual({
        ok: false,
        reason: "WordPress account does not have publish_posts permission",
      });
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it("keeps verification indeterminate for missing or untrusted account permission data", async () => {
    for (const response of [
      { id: 17, username: "editor" },
      { ...account, username: compactPassword },
    ]) {
      mockGuardedFetch.mockResolvedValue(answer(response));
      const result = await wordpressPublisher.verify(credentials);
      expect(result).toEqual({
        ok: false,
        reason: "WordPress did not return usable account permissions",
        indeterminate: true,
      });
      expect(JSON.stringify(result)).not.toContain(compactPassword);
    }
  });

  it("reports a canonical-URL redirect without forwarding credentials to its destination", async () => {
    mockGuardedFetch.mockResolvedValue(
      new Response(null, { status: 301, headers: { location: "https://other.pubrick.org/" } }),
    );
    await expect(wordpressPublisher.verify(credentials)).resolves.toEqual({
      ok: false,
      reason: "WordPress redirected the API request. Use the site's canonical HTTPS URL",
    });
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
    expect(mockGuardedFetch.mock.calls[0]?.[1]?.followRedirects).toBe(false);
  });

  it("separates a rejected application password from a temporary verification failure", async () => {
    mockGuardedFetch.mockResolvedValue(answer(envelope(401), 401));
    await expect(wordpressPublisher.verify(credentials)).resolves.toEqual({
      ok: false,
      reason: "WordPress request was refused (HTTP 401)",
    });
    mockGuardedFetch.mockResolvedValue(answer(envelope(503), 503));
    await expect(wordpressPublisher.verify(credentials)).resolves.toEqual({
      ok: false,
      reason: "WordPress request was refused (HTTP 503)",
      indeterminate: true,
    });
    mockGuardedFetch.mockRejectedValue(new Error(`Socket ${compactPassword}`));
    await expect(wordpressPublisher.verify(credentials)).resolves.toEqual({
      ok: false,
      reason: "WordPress could not be reached before publishing",
      indeterminate: true,
    });
  });
});

describe("WordPress reviewed text publication", () => {
  it("creates once with the reviewed title and escaped plain paragraphs, without a second provider schedule", async () => {
    mockGuardedFetch.mockResolvedValue(answer(receipt, 201));
    const input = {
      title: 'Reviewed <title> & "choices"',
      text: 'First <script>alert(1)</script> & **plain**\r\nsecond line\r\n \r\nLast "paragraph"',
    };
    await expect(wordpressPublisher.publish(credentials, input)).resolves.toEqual({
      externalId: "123",
      externalUrl: receipt.link,
    });
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
    const [url, options] = mockGuardedFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://writer.pubrick.org/blog/wp-json/wp/v2/posts");
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Basic ${basicValue}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      httpsOnly: true,
      allowedHosts: ["writer.pubrick.org"],
      followRedirects: false,
      timeoutMs: WORDPRESS_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      status: "publish",
      title: "Reviewed &lt;title&gt; &amp; &quot;choices&quot;",
      content:
        "<p>First &lt;script&gt;alert(1)&lt;/script&gt; &amp; **plain**<br>\nsecond line</p>\n<p>Last &quot;paragraph&quot;</p>",
    });
    expect(options?.body).not.toContain(compactPassword);
  });

  it.each([undefined, ""])(
    "preserves an omitted or explicitly empty reviewed title (%s)",
    async (title) => {
      mockGuardedFetch.mockResolvedValue(answer(receipt, 201));
      const input = { text: "No invented title", ...(title !== undefined ? { title } : {}) };
      await wordpressPublisher.publish(credentials, input);
      expect(JSON.parse(String(mockGuardedFetch.mock.calls[0]?.[1]?.body))).toEqual({
        status: "publish",
        ...(title !== undefined ? { title: "" } : {}),
        content: "<p>No invented title</p>",
      });
    },
  );

  it("allows an HTTPS installation on a fixed public port and keeps injected transport behind the guard", async () => {
    mockGuardedFetch.mockResolvedValue(
      answer({ ...receipt, link: "https://writer.pubrick.org:8443/blog/?p=123" }, 201),
    );
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      wordpressPublisher.publish(
        { ...credentials, siteUrl: "https://writer.pubrick.org:8443/blog/" },
        { text: "Hello" },
        { baseUrl: "https://writer.pubrick.org:8443/blog", fetchImpl },
      ),
    ).resolves.toEqual({
      externalId: "123",
      externalUrl: "https://writer.pubrick.org:8443/blog/?p=123",
    });
    expect(mockGuardedFetch.mock.calls[0]?.[1]?.fetch).toBe(fetchImpl);
    expect(mockGuardedFetch.mock.calls[0]?.[1]).not.toHaveProperty("skipSsrfCheckForAllowedHosts");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["draft", "pending", "future", "private", "trash", "custom", undefined])(
    "retains an accepted %s record as uncertain instead of claiming publication or retrying",
    async (status) => {
      mockGuardedFetch.mockResolvedValue(answer({ ...receipt, status }, 201));
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AcceptedPublicationError);
      expect(error).toBeInstanceOf(UnknownOutcomePublishError);
      expect((error as AcceptedPublicationError).receipt).toEqual({
        externalId: "123",
        externalUrl: receipt.link,
      });
      expect((error as AcceptedPublicationError).status).toBe(201);
      expect((error as Error).message).not.toContain(compactPassword);
      if (status === "custom") expect((error as Error).message).not.toContain("custom");
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {},
    { status: "publish", id: "123" },
    { status: "publish", id: 0 },
    { status: "publish", id: -1 },
    { status: "publish", id: 1.5 },
    { status: "publish", id: Number.MAX_SAFE_INTEGER + 1 },
  ])("does not retry or confirm an unusable create receipt %j", async (record) => {
    mockGuardedFetch.mockResolvedValue(answer(record, 201));
    const error = await publish().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnknownOutcomePublishError);
    expect(error).not.toBeInstanceOf(AcceptedPublicationError);
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
  });

  it.each([
    "https://other.pubrick.org/blog/post/",
    "http://writer.pubrick.org/blog/post/",
    "https://user:secret@writer.pubrick.org/blog/post/",
    "https://writer.pubrick.org/blog/post/#private-token",
    `https://writer.pubrick.org/blog/?password=${compactPassword}`,
    `https://writer.pubrick.org/blog/?password=${encodeURIComponent(credentials.applicationPassword)}`,
    `https://writer.pubrick.org/blog/?authorization=${basicValue}`,
    "not a URL",
  ])("keeps the ID but discards an unsafe or credential-bearing receipt link %s", async (link) => {
    mockGuardedFetch.mockResolvedValue(answer({ ...receipt, link }, 201));
    await expect(publish()).resolves.toEqual({ externalId: "123", externalUrl: null });
    mockGuardedFetch.mockResolvedValue(answer({ ...receipt, status: "pending", link }, 201));
    const error = await publish().catch((caught: unknown) => caught);
    expect((error as AcceptedPublicationError).receipt).toEqual({
      externalId: "123",
      externalUrl: null,
    });
  });
});

describe("WordPress transport refusals", () => {
  it.each([
    "http://writer.pubrick.org",
    "https://127.0.0.1",
    "https://2130706433",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://10.0.0.1/blog",
    "https://169.254.169.254",
    "https://localhost",
    "https://something.local/blog",
    "https://internal",
    "https://user:secret@writer.pubrick.org/blog",
    "https://writer.pubrick.org/blog?redirect=internal",
    "https://writer.pubrick.org/blog#fragment",
  ])("refuses an unsafe connected URL before any outbound call: %s", async (siteUrl) => {
    await expect(
      wordpressPublisher.publish({ ...credentials, siteUrl }, { text: "Hello" }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://other.pubrick.org/blog/",
    "https://writer.pubrick.org/other/",
    "https://writer.pubrick.org:8443/blog/",
  ])("does not allow an override to retarget the connected site: %s", async (baseUrl) => {
    await expect(
      wordpressPublisher.publish(credentials, { text: "Hello" }, { baseUrl }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it("refuses unsupported image and video delivery, invalid text and malformed credentials before sending", async () => {
    for (const media of [
      { image: { bytes: Uint8Array.of(255), mimeType: "image/jpeg" as const } },
      { video: { bytes: Uint8Array.of(255), mimeType: "video/mp4" as const } },
    ])
      await expect(
        wordpressPublisher.publish(credentials, { text: "Hello", ...media }),
      ).rejects.toBeInstanceOf(PermanentPublishError);
    for (const text of ["", "   ", "x".repeat(wordpressPublisher.maxTextLength + 1)])
      await expect(publish(text)).rejects.toBeInstanceOf(PermanentPublishError);
    for (const changed of [
      { username: "editor:other" },
      { username: " " },
      { applicationPassword: " \t " },
    ])
      await expect(
        wordpressPublisher.publish({ ...credentials, ...changed }, { text: "Hello" }),
      ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it("preserves the DNS/address guard as a known refusal before a post can leave", async () => {
    mockGuardedFetch.mockRejectedValue(
      new GuardedFetchError(GuardedFetchErrorCode.HOSTNAME_UNSAFE, `private ${compactPassword}`),
    );
    await expect(publish()).rejects.toBeInstanceOf(PermanentPublishError);
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
    expect(mockGuardedFetch.mock.calls[0]?.[1]).toMatchObject({
      allowedHosts: ["writer.pubrick.org"],
      httpsOnly: true,
      followRedirects: false,
    });
  });

  it.each([
    [401, PlatformRejectionError],
    [403, PlatformRejectionError],
    [422, PlatformRejectionError],
    [429, TransientPublishError],
    [500, UnknownOutcomePublishError],
    [503, UnknownOutcomePublishError],
  ] as const)(
    "classifies a provider-envelope HTTP %s without exposing credentials",
    async (status, expected) => {
      mockGuardedFetch.mockResolvedValue(answer(envelope(status), status));
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(expected);
      expect((error as Error).message).not.toContain(credentials.applicationPassword);
      expect((error as Error).message).not.toContain(compactPassword);
      expect((error as Error).message).not.toContain(basicValue);
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it.each([403, 429, 502])("does not retry a non-WordPress gateway HTTP %s", async (status) => {
    mockGuardedFetch.mockResolvedValue(new Response("gateway response", { status }));
    await expect(publish()).rejects.toBeInstanceOf(UnknownOutcomePublishError);
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
  });

  it("does not classify an envelope with a mismatched status as a safe retry", async () => {
    mockGuardedFetch.mockResolvedValue(answer(envelope(403), 429));
    await expect(publish()).rejects.toBeInstanceOf(UnknownOutcomePublishError);
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
  });

  it("keeps a POST redirect uncertain without following it even to the connected host", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    mockGuardedFetch.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        status: 303,
        headers: { location: receipt.link },
      }),
    );
    await expect(publish()).rejects.toBeInstanceOf(UnknownOutcomePublishError);
    expect(cancel).toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
    expect(mockGuardedFetch.mock.calls[0]?.[1]?.followRedirects).toBe(false);
  });

  it("bounds create-response reads and treats body loss, invalid JSON and excessive bodies as unknown", async () => {
    for (const response of [
      new Response("not JSON", { status: 201 }),
      new Response(null, { status: 204 }),
      new Response(JSON.stringify({ ...receipt, content: "x".repeat(256_001) }), { status: 201 }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`Body lost ${compactPassword}`));
          },
        }),
        { status: 201 },
      ),
    ]) {
      mockGuardedFetch.mockClear();
      mockGuardedFetch.mockResolvedValue(response);
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnknownOutcomePublishError);
      expect((error as Error).message).not.toContain(compactPassword);
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    }
  });

  it("keeps a body-stream timeout inside the entire request deadline", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      mockGuardedFetch.mockResolvedValue(new Response(new ReadableStream({ cancel })));
      const pending = publish().catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(WORDPRESS_REQUEST_TIMEOUT_MS + 1);
      expect(await pending).toBeInstanceOf(UnknownOutcomePublishError);
      expect(cancel).toHaveBeenCalled();
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes a connection refusal from an uncertain timeout or socket reset after sending", async () => {
    const failures = [
      [new Error(`Socket reset ${compactPassword}`), UnknownOutcomePublishError],
      [new GuardedFetchError(GuardedFetchErrorCode.TIMEOUT, "timeout"), UnknownOutcomePublishError],
      [
        new GuardedFetchError(GuardedFetchErrorCode.TIMEOUT, "timeout", {
          cause: Object.assign(new Error("earlier connection refused"), { code: "ECONNREFUSED" }),
        }),
        UnknownOutcomePublishError,
      ],
      [
        new GuardedFetchError(GuardedFetchErrorCode.NETWORK_ERROR, "socket", {
          cause: Object.assign(new Error("socket reset"), {
            code: "ECONNRESET",
            cause: Object.assign(new Error("earlier connection refused"), { code: "ECONNREFUSED" }),
          }),
        }),
        UnknownOutcomePublishError,
      ],
      [
        new GuardedFetchError(GuardedFetchErrorCode.NETWORK_ERROR, "connect", {
          cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
        }),
        TransientPublishError,
      ],
    ] as const;
    for (const [failure, expected] of failures) {
      mockGuardedFetch.mockClear();
      mockGuardedFetch.mockRejectedValue(failure);
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(expected);
      expect((error as Error).message).not.toContain(compactPassword);
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    }
  });
});
