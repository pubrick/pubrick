import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { render, screen } from "@/test/render";
import { TelegramAccountSettings, TelegramBotSettings } from "./telegram-settings";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
const request = vi.mocked(api);
const empty = {
  state: "revoked",
  bindingId: null,
  challengeId: null,
  expiresAt: null,
  candidate: null,
};
const challengeId = "00000000-0000-4000-8000-000000000001";
const bindingId = "00000000-0000-4000-8000-000000000002";
const account = "/api/notifications/telegram-binding";
const bot = "/api/notifications/telegram-decisions";
beforeEach(() => {
  request.mockReset();
});

describe("Telegram own account", () => {
  it("requires a Telegram claim and explicit browser confirmation before linking", async () => {
    let claimed = false;
    request.mockImplementation(async (path, init) => {
      if (path === account && !init)
        return claimed
          ? {
              ...empty,
              state: "awaiting_web_confirmation",
              challengeId,
              expiresAt: "2099-01-01T00:00:00.000Z",
              candidate: { telegramUserId: "777", displayName: "Synthetic Human" },
            }
          : empty;
      if (path === `${account}/challenge`)
        return {
          challengeId,
          expiresAt: "2099-01-01T00:00:00.000Z",
          startUrl: `https://t.me/SyntheticBot?start=${"a".repeat(43)}`,
        };
      if (path === `${account}/confirm`) return { ...empty, state: "linked", bindingId };
      throw new Error(`Unexpected request: ${path} ${init?.method}`);
    });
    const user = userEvent.setup();
    render(<TelegramAccountSettings />);
    await user.click(await screen.findByRole("button", { name: "Connect Telegram" }));
    expect(await screen.findByRole("link", { name: "Open Telegram" })).toHaveAttribute(
      "href",
      `https://t.me/SyntheticBot?start=${"a".repeat(43)}`,
    );
    expect(screen.queryByRole("button", { name: "Confirm account" })).not.toBeInTheDocument();
    expect(request.mock.calls.some(([path]) => path === `${account}/confirm`)).toBe(false);
    claimed = true;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Telegram user ID: 777")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm account" }));
    expect(await screen.findByText("Your Telegram account is connected.")).toBeVisible();
    expect(request).toHaveBeenCalledWith(`${account}/confirm`, {
      method: "POST",
      body: JSON.stringify({ challengeId }),
    });
  });

  it("does not confirm an expired candidate and does not unlink before consent", async () => {
    request.mockResolvedValue({
      ...empty,
      state: "awaiting_web_confirmation",
      challengeId,
      expiresAt: "2000-01-01T00:00:00.000Z",
      candidate: { telegramUserId: "777", displayName: "Synthetic Human" },
    });
    const user = userEvent.setup();
    render(<TelegramAccountSettings />);
    expect(
      await screen.findByText("This connection link has expired. Create a new link."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm account" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unlink" }));
    expect(screen.getByRole("dialog", { name: "Unlink your Telegram account?" })).toBeVisible();
    expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(request.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});

describe("Telegram workspace bot", () => {
  it("keeps an uncertain remote outcome visible and uses the server revision", async () => {
    request.mockImplementation(async (_path, init) => ({
      state: init ? "setup_uncertain" : "disabled",
      revision: init ? 8 : 7,
      generation: 1,
      hasCredentials: true,
      remoteMutationBlocked: Boolean(init),
    }));
    const user = userEvent.setup();
    render(<TelegramBotSettings />);
    await user.click(await screen.findByRole("button", { name: "Enable account connections" }));
    expect(await screen.findByText("The installation outcome is uncertain.")).toBeVisible();
    expect(
      screen.queryByText("The bot is active for account connections."),
    ).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(`${bot}/setup`, {
      method: "POST",
      body: JSON.stringify({ revision: 7 }),
    });
    expect(screen.getByRole("button", { name: "Retry same setup" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Disable" }));
    expect(
      screen.getByRole("dialog", { name: "Disable Telegram account connections?" }),
    ).toBeVisible();
    expect(request.mock.calls.some(([path]) => path === `${bot}/disable`)).toBe(false);
  });
});
