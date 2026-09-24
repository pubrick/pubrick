import {
  telegramLoginBeginSchema,
  telegramLoginCodeSchema,
  telegramLoginPasswordSchema,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor, within } from "@/test/render";
import TelegramSettingsPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

const request = vi.mocked(api);
const challengeId = "63f381a7-b20d-4ba2-84d5-c62167f11b75";
const expiresAt = "2026-09-25T12:00:00.000Z";

describe("Telegram source account settings", () => {
  beforeEach(() => {
    signedInSession();
    request.mockReset();
  });

  it("sends validated phone, code and 2FA requests without retaining secrets on screen", async () => {
    const user = userEvent.setup();
    request.mockImplementation(async (path, init) => {
      if (path === "/api/sources/telegram-login" && !init)
        return { connected: false, challenge: null };
      if (path === "/api/sources/telegram-login/begin" && init?.method === "POST")
        return { connected: false, challenge: { id: challengeId, stage: "code", expiresAt } };
      if (path === "/api/sources/telegram-login/code" && init?.method === "POST")
        return {
          status: "password_required",
          challenge: { id: challengeId, stage: "password", expiresAt },
        };
      if (path === "/api/sources/telegram-login/password" && init?.method === "POST")
        return { status: "connected" };
      throw new Error("Unexpected request");
    });
    render(<TelegramSettingsPage />);
    await screen.findByText("No Telegram account connected");
    await user.type(screen.getByLabelText("Phone number"), "+15551234567");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByLabelText("Code");
    expect(screen.queryByText("+15551234567")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Code"), "012345");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("2FA password");
    await user.type(screen.getByLabelText("2FA password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Telegram account connected")).toBeInTheDocument();
    expect(screen.queryByLabelText("Code")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("2FA password")).not.toBeInTheDocument();

    const calls = request.mock.calls.filter(([, init]) => init?.method === "POST");
    const bodies = calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { phone: "+15551234567" },
      { challengeId, code: "012345" },
      { challengeId, password: "correct horse" },
    ]);
    expect(telegramLoginBeginSchema.parse(bodies[0])).toEqual(bodies[0]);
    expect(telegramLoginCodeSchema.parse(bodies[1])).toEqual(bodies[1]);
    expect(telegramLoginPasswordSchema.parse(bodies[2])).toEqual(bodies[2]);
  });

  it("shows an owner-only state on a direct visit", async () => {
    request.mockRejectedValue(new ApiError(403, "Forbidden"));
    render(<TelegramSettingsPage />, { locale: "ru" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Управлять аккаунтом может только владелец или администратор рабочей области.",
    );
    expect(screen.queryByRole("button", { name: "Отправить код" })).not.toBeInTheDocument();
  });

  it("sends a workspace-free reader to onboarding", async () => {
    request.mockRejectedValue(new ApiError(403, "No active organization", true));
    render(<TelegramSettingsPage />, { locale: "ru" });
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/ru/onboarding"));
    expect(screen.queryByText(/Управлять аккаунтом может только/)).not.toBeInTheDocument();
  });

  it("confirms disconnect and keeps source data outside this action", async () => {
    const user = userEvent.setup();
    request.mockImplementation(async (path, init) => {
      if (path === "/api/sources/telegram-login" && !init)
        return { connected: true, challenge: null };
      if (path === "/api/sources/telegram-connection" && init?.method === "DELETE")
        return { connected: false };
      throw new Error("Unexpected request");
    });
    render(<TelegramSettingsPage />);
    await screen.findByText("Telegram account connected");
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: "Disconnect Telegram account?" });
    expect(within(dialog).getByText(/Saved sources and stories remain/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/api/sources/telegram-connection", {
        method: "DELETE",
      }),
    );
    expect(await screen.findByText("No Telegram account connected")).toBeInTheDocument();
  });
});
