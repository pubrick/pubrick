import { describe, expect, it } from "vitest";
import { parseTelegramBindingUpdate } from "./telegram-update";

const code = "x".repeat(43);
const update = () => ({
  update_id: 7,
  message: {
    message_id: 8,
    text: `/start ${code}`,
    from: { id: 42, is_bot: false, first_name: "<Human>" },
    chat: { id: 42, type: "private" },
  },
});
describe("Telegram binding boundary", () => {
  it("normalizes safe integers and carries names solely as display metadata", () => {
    expect(parseTelegramBindingUpdate(update(), "SyntheticBot")).toMatchObject({
      operation: "binding_start",
      fromId: "42",
      chatId: "42",
      displayName: "<Human>",
    });
  });
  it("ignores callbacks and unrelated messages", () => {
    expect(
      parseTelegramBindingUpdate({ callback_query: { data: `cr:${code}` } }, "SyntheticBot"),
    ).toBeNull();
    expect(
      parseTelegramBindingUpdate(
        { ...update(), message: { ...update().message, text: "hello" } },
        "SyntheticBot",
      ),
    ).toBeNull();
  });
  it("rejects unsafe or caller supplied decimal-string identities", () => {
    for (const id of [Number.MAX_SAFE_INTEGER + 1, "42", 0, -1, 1.5])
      expect(() =>
        parseTelegramBindingUpdate(
          { ...update(), message: { ...update().message, from: { ...update().message.from, id } } },
          "SyntheticBot",
        ),
      ).toThrow();
  });
  it("ignores bot and non-private contexts before inspecting numeric identities", () => {
    expect(
      parseTelegramBindingUpdate(
        {
          ...update(),
          message: {
            ...update().message,
            from: { ...update().message.from, is_bot: true, id: Number.MAX_SAFE_INTEGER + 1 },
          },
        },
        "SyntheticBot",
      ),
    ).toBeNull();
    for (const type of ["group", "supergroup", "channel"])
      expect(
        parseTelegramBindingUpdate(
          { ...update(), message: { ...update().message, chat: { id: "unsafe", type } } },
          "SyntheticBot",
        ),
      ).toBeNull();
  });
  it("rejects malformed supported private sender and mismatched chat provenance", () => {
    expect(() =>
      parseTelegramBindingUpdate(
        { ...update(), message: { ...update().message, chat: { id: 43, type: "private" } } },
        "SyntheticBot",
      ),
    ).toThrow();
    expect(() =>
      parseTelegramBindingUpdate(
        { ...update(), message: { ...update().message, from: { id: 42 } } },
        "SyntheticBot",
      ),
    ).toThrow();
  });
  it("requires the verified bot when a command target is supplied", () => {
    expect(
      parseTelegramBindingUpdate(
        { ...update(), message: { ...update().message, text: `/start@OtherBot ${code}` } },
        "SyntheticBot",
      ),
    ).toBeNull();
    expect(
      parseTelegramBindingUpdate(
        { ...update(), message: { ...update().message, text: `/start@syntheticbot ${code}` } },
        "SyntheticBot",
      ),
    ).not.toBeNull();
  });
});
