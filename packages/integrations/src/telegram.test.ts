import { describe, expect, it, vi } from "vitest";
import { telegramPublisher } from "./telegram.js";
import { PermanentPublishError, TransientPublishError } from "./types.js";

const CREDS = { botToken: "123:abc", chatId: "-1001234567890" };

function fetchReturning(payload: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status }));
}

function okMessage(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      message_id: 4711,
      chat: { id: -1001234567890, type: "channel", title: "My Channel", username: "mychannel" },
      date: 1756051200,
      ...overrides,
    },
  };
}

describe("telegramPublisher.publish", () => {
  it("posts plain text without parse_mode and returns a public link", async () => {
    const fetchImpl = fetchReturning(okMessage());
    const result = await telegramPublisher.publish(
      CREDS,
      { text: "Hello & welcome" },
      { fetchImpl },
    );

    const call = fetchImpl.mock.calls[0];
    const [url, init] = [call?.[0], call?.[1]];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      chat_id: "-1001234567890",
      text: "Hello & welcome",
      link_preview_options: { is_disabled: true },
    });
    expect(body.parse_mode).toBeUndefined();
    expect(result).toEqual({ externalId: "4711", externalUrl: "https://t.me/mychannel/4711" });
  });

  it("sends html format with parse_mode HTML", async () => {
    const fetchImpl = fetchReturning(okMessage());
    await telegramPublisher.publish(CREDS, { text: "<b>hi</b>", format: "html" }, { fetchImpl });
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.parse_mode).toBe("HTML");
  });

  it("derives a private channel link when the chat has no username", async () => {
    const fetchImpl = fetchReturning(
      okMessage({ chat: { id: -1009876543210, type: "channel", title: "Private" } }),
    );
    const result = await telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl });
    expect(result.externalUrl).toBe("https://t.me/c/9876543210/4711");
  });

  it("treats message_id 0 as published without a link", async () => {
    const fetchImpl = fetchReturning(okMessage({ message_id: 0 }));
    const result = await telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl });
    expect(result).toEqual({ externalId: null, externalUrl: null });
  });

  it("retries once without parse_mode when entity parsing fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities: bad",
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(okMessage()), { status: 200 }));

    const result = await telegramPublisher.publish(
      CREDS,
      { text: "<b>hi", format: "html" },
      { fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCallInit = fetchImpl.mock.calls[1]?.[1];
    expect(JSON.parse((secondCallInit as RequestInit).body as string).parse_mode).toBeUndefined();
    expect(result.externalId).toBe("4711");
  });

  it("throws TransientPublishError with retryAfter on 429", async () => {
    const fetchImpl = fetchReturning(
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 32",
        parameters: { retry_after: 32 },
      },
      429,
    );
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toMatchObject({
      name: "TransientPublishError",
      retryAfterSeconds: 32,
    });
  });

  it("throws TransientPublishError on 5xx and on network failure", async () => {
    const server = fetchReturning({ ok: false, error_code: 502, description: "Bad Gateway" }, 502);
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl: server }),
    ).rejects.toBeInstanceOf(TransientPublishError);

    const network = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl: network }),
    ).rejects.toBeInstanceOf(TransientPublishError);
  });

  it("throws TransientPublishError, not a raw SyntaxError, when a 502 returns an HTML body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TransientPublishError);
  });

  it("throws PermanentPublishError when a 400 returns a non-JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 400 }));
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
  });

  it("throws TransientPublishError, not a raw TypeError, when fetchImpl rejects with undefined", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(undefined);
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TransientPublishError);
  });

  it("throws TransientPublishError, not a raw TypeError, when the body stream errors mid-read", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 502 }));
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TransientPublishError);
  });

  it("throws TransientPublishError, not a raw DOMException, when the body read is aborted", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(TransientPublishError);
  });

  it("never leaks the bot token into a thrown error message", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          `fetch failed: request to https://api.telegram.org/bot${CREDS.botToken}/sendMessage`,
        ),
      );

    let caught: unknown;
    try {
      await telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TransientPublishError);
    expect((caught as Error).message).not.toContain(CREDS.botToken);
  });

  it("throws PermanentPublishError on 403 and 401", async () => {
    for (const code of [401, 403]) {
      const fetchImpl = fetchReturning({ ok: false, error_code: code, description: "nope" }, code);
      await expect(
        telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
      ).rejects.toBeInstanceOf(PermanentPublishError);
    }
  });

  it("rejects text over the platform limit without calling the API", async () => {
    const fetchImpl = vi.fn();
    await expect(
      telegramPublisher.publish(CREDS, { text: "x".repeat(4097) }, { fetchImpl }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("telegramPublisher.verify", () => {
  it("reports ok when the bot is an admin that can post", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { id: 42, username: "my_bot" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: -1001234567890, type: "channel", title: "My Channel" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { status: "administrator", can_post_messages: true },
          }),
          { status: 200 },
        ),
      );

    await expect(telegramPublisher.verify(CREDS, { fetchImpl })).resolves.toEqual({
      ok: true,
      account: "@my_bot",
      target: "My Channel",
    });
  });

  it("reports the reason when the bot lacks posting rights", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { id: 42, username: "my_bot" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, result: { id: -100123, type: "channel", title: "C" } }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { status: "administrator", can_post_messages: false },
          }),
          { status: 200 },
        ),
      );

    const result = await telegramPublisher.verify(CREDS, { fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("reports the reason instead of throwing when the token is invalid", async () => {
    const fetchImpl = fetchReturning(
      { ok: false, error_code: 401, description: "Unauthorized" },
      401,
    );
    const result = await telegramPublisher.verify(CREDS, { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "Unauthorized" });
  });
});
