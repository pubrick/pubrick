import { notificationSettingsUpdateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { signedInSession } from "@/test/auth-client.stub";
import { render, screen, waitFor } from "@/test/render";
import NotificationsPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

const request = vi.mocked(api);

describe("notifications settings", () => {
  beforeEach(() => {
    signedInSession();
    request.mockReset();
    request.mockImplementation(async (path, init) => {
      if (path === "/api/notifications" && !init)
        return { enabled: false, draftReady: false, deliveryProblem: true, hasCredentials: false };
      if (path === "/api/notifications" && init?.method === "PUT")
        return { enabled: true, draftReady: true, deliveryProblem: true, hasCredentials: true };
      if (path === "/api/notifications/test") return { ok: true };
      throw new Error("unexpected request");
    });
  });

  it("sends both credentials and selected event preferences, then clears the secret field", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.type(await screen.findByLabelText("Bot token"), "123:secret");
    await user.type(screen.getByLabelText("Destination chat ID"), "-10042");
    await user.click(screen.getByLabelText("Enable notifications"));
    await user.click(screen.getByLabelText("Draft ready for review"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByLabelText("Bot token")).toHaveValue(""));
    const call = request.mock.calls.find(
      ([path, init]) => path === "/api/notifications" && init?.method === "PUT",
    );
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({
      enabled: true,
      draftReady: true,
      deliveryProblem: true,
      botToken: "123:secret",
      chatId: "-10042",
    });
    expect(notificationSettingsUpdateSchema.parse(body)).toEqual(body);
  });

  it("shows a translated test verdict in Russian", async () => {
    const user = userEvent.setup();
    request.mockImplementation(async (path) => {
      if (path === "/api/notifications")
        return { enabled: true, draftReady: false, deliveryProblem: true, hasCredentials: true };
      return { ok: false };
    });
    render(<NotificationsPage />, { locale: "ru" });
    await user.click(await screen.findByRole("button", { name: "Проверить" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Telegram не подтвердил отправку");
  });

  it("keeps an incomplete destination on the form and focuses the invalid field", async () => {
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.type(await screen.findByLabelText("Bot token"), "123:secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("numeric chat ID");
    expect(screen.getByLabelText("Bot token")).toHaveFocus();
    expect(
      request.mock.calls.some(
        ([path, init]) => path === "/api/notifications" && init?.method === "PUT",
      ),
    ).toBe(false);
  });
});
