import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramDecisionTransport,
  TELEGRAM_DECISION_RESPONSE_BYTES,
  type TelegramWebhookInstallRequest,
} from "./telegram-draft-decisions.js";

const token = "123:synthetic_token";
const install: TelegramWebhookInstallRequest = {
  url: "https://pubrick.example/api/telegram/opaque",
  secret_token: "synthetic_secret",
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: false,
  max_connections: 10,
};
const confirmation = {
  botId: "123",
  chatId: "456",
  text: "Reject this synthetic draft?",
  reviewUrl: "https://pubrick.example/en/content/synthetic",
  rejectCallbackData: `cr:${"x".repeat(43)}`,
  cancelCallbackData: `ca:${"y".repeat(43)}`,
};
const message = {
  message_id: 789,
  from: { id: 123, is_bot: true },
  chat: { id: 456, type: "private" },
};
const bot = { id: 123, is_bot: true, username: "synthetic_bot" };
type Request = { path: string; method: string; contentType: string | undefined; body: unknown };
async function withServer(
  handler: (request: Request, response: ServerResponse) => void,
  test: (baseUrl: string, requests: Request[]) => Promise<void>,
) {
  const requests: Request[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const value = {
      path: request.url ?? "",
      method: request.method ?? "",
      contentType: request.headers["content-type"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    };
    requests.push(value);
    handler(value, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback listener");
  try {
    await test(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
function json(response: ServerResponse, result: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
}

describe("Telegram decision single-attempt transport", () => {
  it("uses six exact POST methods and frozen setup options on real loopback HTTP", async () => {
    await withServer(
      (request, response) => {
        const method = request.path.split("/").at(-1);
        json(response, {
          ok: true,
          result:
            method === "getMe"
              ? bot
              : method === "getWebhookInfo"
                ? {
                    url: install.url,
                    has_custom_certificate: false,
                    pending_update_count: 3,
                    last_error_message: "never exported",
                  }
                : method === "sendMessage"
                  ? message
                  : true,
        });
      },
      async (baseUrl, requests) => {
        const transport = createTelegramDecisionTransport({ baseUrl });
        expect(await transport.getMe(token)).toEqual({
          status: "confirmed",
          value: { botId: "123", username: "synthetic_bot" },
        });
        expect(await transport.getWebhookInfo(token)).toEqual({
          status: "confirmed",
          value: { url: install.url, pendingUpdateCount: 3 },
        });
        const frozen = structuredClone(install);
        expect(await transport.setWebhook(token, frozen)).toEqual({
          status: "confirmed",
          value: true,
        });
        expect(frozen).toEqual(install);
        expect(await transport.deleteWebhook(token, { drop_pending_updates: false })).toEqual({
          status: "confirmed",
          value: true,
        });
        expect(await transport.sendPrivateConfirmation(token, confirmation)).toEqual({
          status: "confirmed",
          value: { botId: "123", chatId: "456", messageId: "789" },
        });
        expect(
          await transport.answerCallbackQuery(token, {
            callbackQueryId: "query_123",
            text: "Recorded",
            showAlert: false,
          }),
        ).toEqual({ status: "confirmed", value: true });
        expect(requests.map((request) => request.path)).toEqual(
          [
            "getMe",
            "getWebhookInfo",
            "setWebhook",
            "deleteWebhook",
            "sendMessage",
            "answerCallbackQuery",
          ].map((method) => `/bot${token}/${method}`),
        );
        expect(
          requests.every(
            (request) => request.method === "POST" && request.contentType === "application/json",
          ),
        ).toBe(true);
        expect(requests.map((request) => request.body)).toEqual([
          {},
          {},
          install,
          { drop_pending_updates: false },
          {
            chat_id: "456",
            text: confirmation.text,
            reply_markup: {
              inline_keyboard: [
                [{ text: "Review in Pubrick", url: confirmation.reviewUrl }],
                [
                  { text: "Reject", callback_data: confirmation.rejectCallbackData },
                  { text: "Cancel", callback_data: confirmation.cancelCallbackData },
                ],
              ],
            },
          },
          { callback_query_id: "query_123", text: "Recorded", show_alert: false, cache_time: 0 },
        ]);
        expect(requests[4]?.body).not.toHaveProperty("parse_mode");
      },
    );
  });
  it("refuses unsafe provider IDs and malformed successful results without retry", async () => {
    for (const result of [
      { ...bot, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...bot, id: "123" },
      { ...bot, id: -1 },
      { ...bot, id: 1.5 },
      { ...bot, is_bot: false },
      { id: 123, is_bot: true },
      { ...bot, username: "unsafe/name" },
    ]) {
      await withServer(
        (_request, response) => json(response, { ok: true, result }),
        async (baseUrl, requests) => {
          expect(await createTelegramDecisionTransport({ baseUrl }).getMe(token)).toEqual({
            status: "unknown",
          });
          expect(requests).toHaveLength(1);
        },
      );
    }
    await withServer(
      (_request, response) =>
        json(response, { ok: true, result: { ...bot, id: Number.MAX_SAFE_INTEGER } }),
      async (baseUrl) => {
        expect(await createTelegramDecisionTransport({ baseUrl }).getMe(token)).toEqual({
          status: "confirmed",
          value: { botId: "9007199254740991", username: "synthetic_bot" },
        });
      },
    );
  });
  it("confirms private delivery only with matching chat/bot and positive safe message provenance", async () => {
    for (const result of [
      { ...message, message_id: 0 },
      { ...message, message_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...message, from: { id: 999, is_bot: true } },
      { ...message, from: { id: 123, is_bot: false } },
      { ...message, chat: { id: 999, type: "private" } },
      { ...message, chat: { id: 456, type: "group" } },
      { message_id: 789, chat: message.chat },
    ]) {
      await withServer(
        (_request, response) => json(response, { ok: true, result }),
        async (baseUrl, requests) => {
          expect(
            await createTelegramDecisionTransport({ baseUrl }).sendPrivateConfirmation(
              token,
              confirmation,
            ),
          ).toEqual({ status: "unknown" });
          expect(requests).toHaveLength(1);
        },
      );
    }
  });
  it("rejects forbidden frozen options and oversized callbacks before any physical call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const transport = createTelegramDecisionTransport({ fetchImpl });
    expect(
      await transport.setWebhook(token, {
        ...install,
        drop_pending_updates: true,
      } as unknown as TelegramWebhookInstallRequest),
    ).toEqual({ status: "rejected" });
    expect(
      await transport.setWebhook(token, { ...install, url: "http://foreign.example/hook" }),
    ).toEqual({ status: "rejected" });
    expect(
      await transport.setWebhook(token, { ...install, secret_token: "invalid secret" }),
    ).toEqual({ status: "rejected" });
    expect(
      await transport.setWebhook(token, {
        ...install,
        extra: "not frozen",
      } as TelegramWebhookInstallRequest),
    ).toEqual({ status: "rejected" });
    expect(
      await transport.sendPrivateConfirmation(token, {
        ...confirmation,
        rejectCallbackData: `cr:${"x".repeat(65)}`,
      }),
    ).toEqual({ status: "rejected" });
    expect(
      await transport.sendPrivateConfirmation(token, { ...confirmation, chatId: "-100123" }),
    ).toEqual({ status: "rejected" });
    expect(await transport.getMe("unsafe/path:token")).toEqual({ status: "rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("returns safe rejected versus uncertain outcomes for provider failures and malformed bodies", async () => {
    for (const [status, body, outcome] of [
      [
        401,
        { ok: false, error_code: 401, description: `https://api.telegram.org/bot${token}/getMe` },
        "rejected",
      ],
      [429, { ok: false, error_code: 429 }, "rejected"],
      [500, { ok: false, error_code: 500 }, "unknown"],
      [200, { ok: false, error_code: 503 }, "unknown"],
      [400, { description: "malformed provider failure" }, "unknown"],
      [200, { ok: true, result: false }, "unknown"],
    ] as const) {
      await withServer(
        (_request, response) => json(response, body, status),
        async (baseUrl, requests) => {
          expect(
            await createTelegramDecisionTransport({ baseUrl }).setWebhook(token, install),
          ).toEqual({ status: outcome });
          expect(requests).toHaveLength(1);
        },
      );
    }
    await withServer(
      (_request, response) => {
        response.end("not-json");
      },
      async (baseUrl, requests) => {
        expect(await createTelegramDecisionTransport({ baseUrl }).getMe(token)).toEqual({
          status: "unknown",
        });
        expect(requests).toHaveLength(1);
      },
    );
  });
  it("bounds chunked/declared response bytes, body deadlines and redirects on native HTTP", async () => {
    for (const declared of [false, true]) {
      await withServer(
        (_request, response) => {
          response.writeHead(
            200,
            declared ? { "content-length": TELEGRAM_DECISION_RESPONSE_BYTES + 1 } : {},
          );
          response.end("x".repeat(TELEGRAM_DECISION_RESPONSE_BYTES + 1));
        },
        async (baseUrl, requests) => {
          expect(await createTelegramDecisionTransport({ baseUrl }).getMe(token)).toEqual({
            status: "unknown",
          });
          expect(requests).toHaveLength(1);
        },
      );
    }
    await withServer(
      (_request, response) => {
        response.writeHead(200);
        response.write('{"ok":true,');
      },
      async (baseUrl, requests) => {
        expect(
          await createTelegramDecisionTransport({ baseUrl, timeoutMs: 100 }).getMe(token),
        ).toEqual({ status: "unknown" });
        expect(requests).toHaveLength(1);
      },
    );
    await withServer(
      (_request, response) => {
        response.writeHead(302, { location: "/redirected" });
        response.end();
      },
      async (baseUrl, requests) => {
        expect(await createTelegramDecisionTransport({ baseUrl }).getMe(token)).toEqual({
          status: "unknown",
        });
        expect(requests).toHaveLength(1);
      },
    );
  });
  it("makes one injected physical fetch on network uncertainty and never exports its sensitive exception", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(
          `failed https://api.telegram.org/bot${token}/setWebhook secret=${install.secret_token}`,
        ),
      );
    const result = await createTelegramDecisionTransport({ fetchImpl }).setWebhook(token, install);
    expect(result).toEqual({ status: "unknown" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(install.secret_token);
  });
});

describe("initial draft notification transport", () => {
  const initial = {
    botId: "123",
    chatId: "-10042",
    text: "Synthetic draft ready",
    reviewUrl: "https://pubrick.example/en/content/synthetic?intent=review",
    scheduleUrl: "https://pubrick.example/en/content/synthetic?intent=schedule",
    publishUrl: "https://pubrick.example/en/content/synthetic?intent=publish",
    rejectCallbackData: `ir:${"x".repeat(43)}`,
  };
  it("preserves three URL controls and one callback with exact signed-chat provenance", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 789,
            from: { id: 123, is_bot: true },
            chat: { id: -10042, type: "supergroup" },
          },
        }),
        { status: 200 },
      ),
    );
    const transport = createTelegramDecisionTransport({ fetchImpl });
    expect(await transport.sendInitialNotification(token, initial)).toEqual({
      status: "confirmed",
      value: { botId: "123", chatId: "-10042", messageId: "789" },
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1].body as string);
    expect(body.reply_markup.inline_keyboard).toEqual([
      [
        { text: "Review", url: initial.reviewUrl },
        { text: "Schedule", url: initial.scheduleUrl },
      ],
      [
        { text: "Publish", url: initial.publishUrl },
        { text: "Reject", callback_data: initial.rejectCallbackData },
      ],
    ]);
    expect(body).not.toHaveProperty("parse_mode");
  });
  it("refuses malformed initial requests without a fetch", async () => {
    const fetchImpl = vi.fn();
    const transport = createTelegramDecisionTransport({ fetchImpl });
    for (const value of [
      { ...initial, rejectCallbackData: `cr:${"x".repeat(43)}` },
      { ...initial, reviewUrl: "http://pubrick.example/review" },
      { ...initial, chatId: "0" },
    ])
      expect(await transport.sendInitialNotification(token, value)).toEqual({ status: "rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("treats unsafe, missing or mismatched message provenance as unknown and never retries", async () => {
    for (const result of [
      {
        message_id: Number.MAX_SAFE_INTEGER + 1,
        from: { id: 123, is_bot: true },
        chat: { id: -10042, type: "supergroup" },
      },
      {
        message_id: 789,
        from: { id: 124, is_bot: true },
        chat: { id: -10042, type: "supergroup" },
      },
      {
        message_id: 789,
        from: { id: 123, is_bot: true },
        chat: { id: -10043, type: "supergroup" },
      },
      { message_id: 789, chat: { id: -10042, type: "channel" } },
    ]) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
      expect(
        await createTelegramDecisionTransport({ fetchImpl }).sendInitialNotification(
          token,
          initial,
        ),
      ).toEqual({ status: "unknown" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
