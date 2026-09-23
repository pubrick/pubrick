import { describe, expect, it, vi } from "vitest";
import { sendTelegramNotification } from "./telegram-notification.js";

const credentials = { botToken: "secret:bot", chatId: "-10042" };

describe("sendTelegramNotification", () => {
  it("sends plain text and a URL-only button to the configured chat", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const ok = await sendTelegramNotification(credentials, "A <new> draft & review", {
      baseUrl: "http://localhost:1234",
      button: { text: "Open post", url: "https://pubrick.example/en/content/one" },
      fetchImpl,
    });
    expect(ok).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:1234/botsecret:bot/sendMessage");
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: "-10042",
      text: "A <new> draft & review",
      reply_markup: {
        inline_keyboard: [[{ text: "Open post", url: "https://pubrick.example/en/content/one" }]],
      },
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("parse_mode");
  });

  it("returns an unconfirmed result on network failure without a second request or leaked token", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("fetch to /botsecret:bot/sendMessage failed"));
    const result = await sendTelegramNotification(credentials, "Hello", { fetchImpl });
    expect(result).toBe("unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
