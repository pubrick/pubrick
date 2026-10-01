import { describe, expect, it } from "vitest";
import { parseTelegramDecisionCallback } from "./telegram-callback-update";

function update(prefix = "ir", chatId = -42, chatType = "supergroup") {
  return {
    update_id: 0,
    callback_query: {
      id: "synthetic-query",
      data: `${prefix}:${"x".repeat(43)}`,
      from: { id: 42, is_bot: false },
      message: {
        date: 1790880000,
        message_id: 7,
        from: { id: 123, is_bot: true },
        chat: { id: chatId, type: chatType },
      },
    },
  };
}
describe("Telegram decision callback provenance", () => {
  it("normalizes a bot-authored group start without treating chat as actor", () => {
    expect(parseTelegramDecisionCallback(update(), "123")).toMatchObject({
      operation: "initial_reject",
      updateId: "0",
      fromId: "42",
      chatId: "-42",
      messageBotId: "123",
    });
  });
  it("admits explicit rejection and cancel only in the actor's private chat", () => {
    expect(parseTelegramDecisionCallback(update("cr", 42, "private"), "123")?.operation).toBe(
      "confirm_reject",
    );
    expect(parseTelegramDecisionCallback(update("ca", 42, "private"), "123")?.operation).toBe(
      "cancel",
    );
    expect(() => parseTelegramDecisionCallback(update("cr"), "123")).toThrow();
    expect(() => parseTelegramDecisionCallback(update("ca", 43, "private"), "123")).toThrow();
  });
  it("ignores unrelated and bot-authored actions without admission", () => {
    expect(parseTelegramDecisionCallback({ callback_query: { data: "other" } }, "123")).toBeNull();
    const value = update();
    value.callback_query.from.is_bot = true;
    expect(parseTelegramDecisionCallback(value, "123")).toBeNull();
  });
  it("refuses inaccessible, inline and other-bot messages", () => {
    const inaccessible = update();
    inaccessible.callback_query.message.date = 0;
    expect(() => parseTelegramDecisionCallback(inaccessible, "123")).toThrow();
    const inline = update();
    expect(() =>
      parseTelegramDecisionCallback(
        { ...inline, callback_query: { ...inline.callback_query, inline_message_id: "forwarded" } },
        "123",
      ),
    ).toThrow();
    expect(() => parseTelegramDecisionCallback(update(), "124")).toThrow();
  });
  it("refuses lossy numbers and caller-supplied decimal strings", () => {
    const unsafe = update();
    unsafe.callback_query.from.id = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseTelegramDecisionCallback(unsafe, "123")).toThrow();
    const value = update();
    expect(() => parseTelegramDecisionCallback({ ...value, update_id: "0" }, "123")).toThrow();
    expect(() =>
      parseTelegramDecisionCallback(
        {
          ...value,
          callback_query: {
            ...value.callback_query,
            message: { ...value.callback_query.message, message_id: "7" },
          },
        },
        "123",
      ),
    ).toThrow();
  });
});
