import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_REQUEST_TIMEOUT_MS, telegramPublisher } from "./telegram.js";
import {
  PermanentPublishError,
  type PublishInput,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";

const CREDS = { botToken: "123:abc", chatId: "-1001234567890" };

function fetchReturning(payload: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status }));
}

/**
 * A rejected fetch shaped the way undici shapes one: the real reason hangs off
 * `cause` with a `code`, and only the codes raised while CONNECTING prove the
 * request never went out. Measured against Node's real fetch, not invented.
 */
function fetchRejectingWith(code: string | undefined, message: string) {
  const cause = Object.assign(new Error(message), code === undefined ? {} : { code });
  return vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));
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

  // A 400 from a gateway, with an unrecognized body that happens to mention
  // "parse entities", must not be read as Telegram's own rejection — only
  // Telegram's envelope (`ok:false` plus an `error_code`) is proof the
  // platform itself saw and refused the request.
  it("classifies a 400 whose body is not Telegram's envelope as permanent, even if it mentions parse entities", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("proxy error: can't parse entities", { status: 400 }));
    await expect(
      telegramPublisher.publish(CREDS, { text: "hi" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
    // Class identity, not `error.name`: the classes now live in @pubrick/shared
    // and are re-exported under these names, so the label reads "TransientError"
    // while `instanceof` — what the publish path actually branches on — holds.
    const caught = await telegramPublisher
      .publish(CREDS, { text: "x" }, { fetchImpl })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TransientPublishError);
    expect((caught as TransientPublishError).retryAfterSeconds).toBe(32);
  });

  it("throws TransientPublishError on Telegram's own 5xx envelope", async () => {
    const server = fetchReturning({ ok: false, error_code: 502, description: "Bad Gateway" }, 502);
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl: server }),
    ).rejects.toBeInstanceOf(TransientPublishError);
  });

  // MUTATION PIN. `envelope.code >= 500` -> `> 500` survived the whole suite:
  // every 5xx envelope under test was 502 or 503. A bare 500 is the boundary,
  // and getting it wrong turns Telegram's own "try again" into a permanent
  // failure — a post that silently never goes out.
  it("treats Telegram's error_code 500 — the exact boundary — as transient, not permanent", async () => {
    const fetchImpl = fetchReturning(
      { ok: false, error_code: 500, description: "Internal Server Error" },
      500,
    );
    const caught = await telegramPublisher
      .publish(CREDS, { text: "x" }, { fetchImpl })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(TransientPublishError);
    expect(caught).not.toBeInstanceOf(PermanentPublishError);
  });

  // The other half of the same boundary: 499 is not a server error, so
  // Telegram saying it is Telegram refusing, permanently.
  it("treats Telegram's error_code 499 as permanent", async () => {
    const fetchImpl = fetchReturning({ ok: false, error_code: 499, description: "nope" }, 499);
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
  });

  // A gateway's 502, not Telegram's. Nothing here says whether Telegram ever
  // saw the request — the 502 may be on the REPLY leg, with the post already
  // live — so this must never be retryable. It used to be transient, and that
  // retry is finding (a)'s second post.
  it("throws UnknownOutcomePublishError, not Transient, when a 502 returns an HTML body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const caught = await telegramPublisher
      .publish(CREDS, { text: "x" }, { fetchImpl })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(UnknownOutcomePublishError);
    expect(caught).not.toBeInstanceOf(TransientPublishError);
  });

  // MUTATION PIN for the unrecognized-body boundary. `status >= 500` -> `> 500`
  // leaves a bare 500 falling into the 4xx branch and being called permanent —
  // "we know this did not post" — when nothing here knows that at all.
  it("calls an unrecognized body on HTTP 500 — the exact boundary — unknown, not permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("upstream exploded", { status: 500 }));
    const caught = await telegramPublisher
      .publish(CREDS, { text: "x" }, { fetchImpl })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(UnknownOutcomePublishError);
    expect(caught).not.toBeInstanceOf(PermanentPublishError);
  });

  // And the other side of it: a 499 with an unrecognized body is a rejection by
  // whatever answered, which is a refusal to forward, which is not a post.
  it("calls an unrecognized body on HTTP 499 permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 499 }));
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
  });

  // 429 is carved out of the 4xx branch on purpose: an intermediary throttling
  // us cannot be told apart from one throttling Telegram's reply.
  it("calls an unrecognized body on HTTP 429 unknown, not permanent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    const caught = await telegramPublisher
      .publish(CREDS, { text: "x" }, { fetchImpl })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(UnknownOutcomePublishError);
    expect(caught).not.toBeInstanceOf(PermanentPublishError);
  });

  it("throws PermanentPublishError when a 400 returns a non-JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 400 }));
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
  });

  it("throws UnknownOutcomePublishError, not a raw TypeError, when fetchImpl rejects with undefined", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(undefined);
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  it("throws UnknownOutcomePublishError, not a raw TypeError, when the body stream errors mid-read", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 502 }));
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  it("throws UnknownOutcomePublishError, not a raw DOMException, when the body read is aborted", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(stream, { status: 200 }));
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  // NOT a pin for either half of `redactToken`, despite reading like one, and a
  // security review that cited it as one was wrong. It puts the token inside a
  // `/bot<token>/` URL, which is the ONE shape both passes redact, so it holds
  // as long as EITHER survives: deleting the literal pass alone leaves it
  // green, and so does deleting the URL pass alone. It pins the disjunction —
  // "at least one redaction still runs" — and nothing finer. The per-half pins
  // are in the "bot-token redaction" block at the bottom of this file; keep
  // this one for the end-to-end shape it does cover.
  it("never leaks the bot token when the token rides inside the request URL", async () => {
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

    expect(caught).toBeInstanceOf(UnknownOutcomePublishError);
    expect((caught as Error).message).not.toContain(CREDS.botToken);
  });

  it("resolves to a linkless success, not a throw, when ok:true carries a null result", async () => {
    const fetchImpl = fetchReturning({ ok: true, result: null });
    await expect(telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl })).resolves.toEqual({
      externalId: null,
      externalUrl: null,
    });
  });

  it("resolves to a linkless success, not a throw, when ok:true's result has no chat", async () => {
    const fetchImpl = fetchReturning({ ok: true, result: { message_id: 123 } });
    await expect(telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl })).resolves.toEqual({
      externalId: null,
      externalUrl: null,
    });
  });

  // A 200 whose body we cannot read as Telegram's envelope is the worst case
  // there is: the status says something accepted the request and the body says
  // we have no idea what. Unknown, never permanent.
  it("throws UnknownOutcomePublishError when the body is the JSON literal null on HTTP 200", async () => {
    const fetchImpl = fetchReturning(null, 200);
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  it("throws UnknownOutcomePublishError when the body is the JSON literal null on HTTP 503", async () => {
    const fetchImpl = fetchReturning(null, 503);
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  it("classifies a bare JSON string body instead of crashing", async () => {
    const fetchImpl = fetchReturning("just a string, not an envelope", 200);

    let caught: unknown;
    try {
      await telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl });
    } catch (error) {
      caught = error;
    }

    expect(
      caught instanceof PermanentPublishError ||
        caught instanceof TransientPublishError ||
        caught instanceof UnknownOutcomePublishError,
    ).toBe(true);
  });

  // The connect-phase allowlist. These four are the only fetch rejections that
  // prove no request bytes reached the wire, so they are the only ones a retry
  // may act on.
  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])(
    "treats a %s rejection as transient — the connection never carried a request",
    async (code) => {
      const fetchImpl = fetchRejectingWith(code, `connect ${code} 127.0.0.1:443`);
      const caught = await telegramPublisher
        .publish(CREDS, { text: "x" }, { fetchImpl })
        .catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(TransientPublishError);
      expect(caught).not.toBeInstanceOf(UnknownOutcomePublishError);
    },
  );

  // The shape Node actually produces when the peer resets after the request
  // body is written — finding (a) in one assertion. It is NOT a connect-phase
  // code, so it must not be retryable.
  it("treats a UND_ERR_SOCKET rejection as unknown — the body was already on the wire", async () => {
    const fetchImpl = fetchRejectingWith("UND_ERR_SOCKET", "other side closed");
    const caught = await telegramPublisher
      .publish(CREDS, { text: "x" }, { fetchImpl })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(UnknownOutcomePublishError);
    expect(caught).not.toBeInstanceOf(TransientPublishError);
  });

  it("treats a rejection with no code at all as unknown, not transient", async () => {
    const fetchImpl = fetchRejectingWith(undefined, "something went wrong");
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  // The adapter's own AbortSignal.timeout: it covers the whole request, so it
  // cannot tell a connection that never opened from a reply that never came.
  it("treats the request timeout as unknown", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      );
    await expect(
      telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl }),
    ).rejects.toBeInstanceOf(UnknownOutcomePublishError);
  });

  it("throws PermanentPublishError, without calling the API, when the request body cannot be JSON-serialized", async () => {
    const fetchImpl = vi.fn();
    // A real caller can't construct this through the PublishInput type, but a
    // JS (non-TS) consumer can pass anything at runtime.
    const unserializableInput = { text: 10n } as unknown as PublishInput;

    await expect(
      telegramPublisher.publish(CREDS, unserializableInput, { fetchImpl }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).not.toHaveBeenCalled();
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
      telegramPublisher.publish(
        CREDS,
        { text: "x".repeat(telegramPublisher.maxTextLength + 1) },
        { fetchImpl },
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // MUTATION PIN. `length > MAX_TEXT_LENGTH` -> `>=` survived the whole suite:
  // the only length under test was 4097, which both forms reject. Text of
  // exactly the limit is legal and must go out — the mutant silently refuses to
  // publish every post that lands on the boundary.
  it("accepts text of exactly the platform limit and sends it", async () => {
    const fetchImpl = fetchReturning(okMessage());
    const text = "x".repeat(telegramPublisher.maxTextLength);
    await expect(telegramPublisher.publish(CREDS, { text }, { fetchImpl })).resolves.toMatchObject({
      externalId: "4711",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string).text).toBe(text);
  });

  // The lower boundary of the same check, for the same reason: `length === 0`
  // must be refused, and refused without a call.
  it("rejects empty text without calling the API", async () => {
    const fetchImpl = vi.fn();
    await expect(
      telegramPublisher.publish(CREDS, { text: "" }, { fetchImpl }),
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

  it("reports the reason instead of throwing when getMe's result is malformed", async () => {
    const fetchImpl = fetchReturning({ ok: true, result: null });
    const result = await telegramPublisher.verify(CREDS, { fetchImpl });
    expect(result).toEqual({ ok: false, reason: "Telegram returned an unexpected getMe response" });
  });

  it("reports the reason instead of throwing when getChat's result is malformed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { id: 42, username: "my_bot" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: null }), { status: 200 }),
      );

    const result = await telegramPublisher.verify(CREDS, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: "Telegram returned an unexpected getChat response",
    });
  });

  it("reports the reason instead of throwing when getChatMember's result is malformed", async () => {
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
        new Response(JSON.stringify({ ok: true, result: null }), { status: 200 }),
      );

    const result = await telegramPublisher.verify(CREDS, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      reason: "Telegram returned an unexpected getChatMember response",
    });
  });
});

/**
 * `redactToken` is two independent passes, and every existing assertion fed it
 * the one input both passes handle — a token inside a `/bot<token>/` URL — so
 * either half could be deleted with the suite still green. These pin them one
 * at a time: each test carries a token in a shape only ONE pass can catch, so
 * deleting that pass is the only edit that can turn it red.
 *
 * What is at stake is not tidiness. The redacted string is the `message` of the
 * thrown error, and that message is what the worker persists verbatim as
 * `adaptations.last_error` (apps/worker/src/publish/publish.service.ts, `const
 * message = (error as Error).message`), which the api selects as `lastError`
 * (apps/api/src/content/content.repository.ts) and a screen prints. An
 * unredacted token in a platform error is a bot token rendered in a browser.
 */
describe("bot-token redaction", () => {
  /** The value the worker writes to `adaptations.last_error` for a failed publish. */
  async function lastErrorFor(fetchImpl: typeof fetch): Promise<string> {
    const caught = await telegramPublisher
      .publish(CREDS, { text: "x" }, { fetchImpl })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    return (caught as Error).message;
  }

  // PIN for the LITERAL-token pass. The token appears in prose, with no `/bot`
  // and no surrounding slashes, so the URL-shape regex cannot reach it: only
  // `message.split(botToken).join("***")` removes it. This is not a contrived
  // shape — an intermediary that rejects the credential says so in its own
  // words, and its body becomes the snippet in an unrecognized-response error.
  it("redacts the exact token when it appears outside any URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(`gateway refused credential ${CREDS.botToken} for upstream`, { status: 502 }),
      );

    const message = await lastErrorFor(fetchImpl);
    expect(message).not.toContain(CREDS.botToken);
    expect(message).toContain("***");
    // The rest of the snippet must survive: redaction removes the secret, not
    // the diagnosis the operator needs.
    expect(message).toContain("gateway refused credential");
  });

  // The same pass, reached down the other road into `redactToken`: Telegram's
  // OWN `ok:false` description. A platform that echoes the credential it just
  // refused hands it straight to the error path, and this description never
  // contains a URL either.
  it("redacts the exact token out of Telegram's own error description", async () => {
    const fetchImpl = fetchReturning(
      { ok: false, error_code: 400, description: `Bad Request: token ${CREDS.botToken} rejected` },
      400,
    );

    const message = await lastErrorFor(fetchImpl);
    expect(message).not.toContain(CREDS.botToken);
    expect(message).toContain("***");
  });

  // PIN for the URL-SHAPE pass. The token here is NOT this channel's token, so
  // the literal pass has nothing to match on and only the `/bot<...>/` regex
  // can remove it. That is exactly the defense-in-depth the docstring claims:
  // `baseUrl` is configurable, and a shared egress proxy quoting the request
  // line it failed to forward can quote a token this call never held.
  it("redacts a bot-token URL shape even when the token is not ours", async () => {
    const foreignToken = "987654321:AAHnotOurBotTokenAtAll";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          `Bad gateway proxying POST https://api.telegram.org/bot${foreignToken}/sendMessage`,
          { status: 502 },
        ),
      );

    const message = await lastErrorFor(fetchImpl);
    expect(message).not.toContain(foreignToken);
    expect(message).toContain("/bot***/");
  });

  // The other rendered field. `verify()` does not throw — it returns
  // `{ ok: false, reason }`, and apps/api/src/channels/channels.repository.ts
  // returns that object straight out of the controller, so `reason` is served
  // to the browser as-is. Same redaction, second screen.
  it("keeps the token out of the connection-test reason the api serves verbatim", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(`upstream rejected credential ${CREDS.botToken}`, { status: 502 }),
      );

    const result = await telegramPublisher.verify(CREDS, { fetchImpl });
    expect(result.ok).toBe(false);
    const reason = (result as { ok: false; reason: string }).reason;
    expect(reason).not.toContain(CREDS.botToken);
    expect(reason).toContain("***");
  });
});

/**
 * The request timeout. `AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS)` could
 * be deleted from the fetch options with the whole suite still green: the
 * "treats the request timeout as unknown" test above feeds a TimeoutError to
 * `fetchImpl` by hand, which proves how such a rejection is CLASSIFIED and says
 * nothing about whether anything would ever produce one. Without the signal a
 * hung connection never aborts, the pg-boss job outlives the worker's shutdown
 * window (apps/worker/src/publish/publish.service.ts derives that window from
 * this very constant) and the redelivery is the duplicate post.
 */
describe("request timeout wiring", () => {
  it("hands fetch an abort signal built from TELEGRAM_REQUEST_TIMEOUT_MS", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchImpl = fetchReturning(okMessage());
      await telegramPublisher.publish(CREDS, { text: "x" }, { fetchImpl });

      // The constant is what gets applied — not a hardcoded literal that has
      // drifted from it, and not some other duration.
      expect(timeoutSpy).toHaveBeenCalledWith(TELEGRAM_REQUEST_TIMEOUT_MS);
      // ...and the signal it produced is the one the request actually carries.
      // `toBe` on the spy's own return value is what makes deleting the
      // `signal:` option fail here instead of quietly passing.
      const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal).toBe(timeoutSpy.mock.results[0]?.value);
      expect(init.signal?.aborted).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("puts a timeout signal on every call verify makes, not just on publish", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, result: { id: 42, username: "my_bot" } }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, result: { id: -1001234567890, title: "My Channel" } }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, result: { status: "creator" } }), {
            status: 200,
          }),
        );

      await telegramPublisher.verify(CREDS, { fetchImpl });

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      for (const call of fetchImpl.mock.calls) {
        expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
      }
      expect(timeoutSpy).toHaveBeenCalledTimes(3);
      for (const call of timeoutSpy.mock.calls) {
        expect(call[0]).toBe(TELEGRAM_REQUEST_TIMEOUT_MS);
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
