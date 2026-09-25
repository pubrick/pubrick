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
        return {
          enabled: false,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: false,
          digests: [],
        };
      if (path === "/api/notifications" && init?.method === "PUT")
        return {
          enabled: true,
          draftReady: true,
          deliveryProblem: true,
          hasCredentials: true,
          digests: [],
        };
      if (path === "/api/notifications/test") return { ok: true };
      if (path === "/api/notifications/events") return { events: [], nextCursor: null };
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
      digests: [],
      botToken: "123:secret",
      chatId: "-10042",
    });
    expect(notificationSettingsUpdateSchema.parse(body)).toEqual(body);
  });

  it("shows a translated test verdict in Russian", async () => {
    const user = userEvent.setup();
    request.mockImplementation(async (path) => {
      if (path === "/api/notifications")
        return {
          enabled: true,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: true,
          digests: [],
        };
      if (path === "/api/notifications/events") return { events: [], nextCursor: null };
      return { ok: false };
    });
    render(<NotificationsPage />, { locale: "ru" });
    await user.click(await screen.findByRole("button", { name: "Проверить" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Telegram не подтвердил отправку");
  });

  it("saves a brand digest with an IANA timezone and local hour", async () => {
    const brandId = "7b72825b-71e1-49fa-8764-2472c9d965f9";
    request.mockImplementation(async (path, init) => {
      if (path === "/api/notifications" && !init)
        return {
          enabled: true,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: true,
          digests: [{ brandId, brandName: "North", enabled: false, timezone: "UTC", localHour: 9 }],
        };
      if (path === "/api/notifications" && init?.method === "PUT")
        return {
          enabled: true,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: true,
          digests: [
            {
              brandId,
              brandName: "North",
              enabled: true,
              timezone: "America/New_York",
              localHour: 8,
            },
          ],
        };
      if (path === "/api/notifications/events") return { events: [], nextCursor: null };
      throw new Error("unexpected request");
    });
    const user = userEvent.setup();
    render(<NotificationsPage />);
    await user.click(await screen.findByLabelText("Digest for North"));
    await user.click(screen.getByText("Advanced"));
    await user.clear(screen.getByLabelText("IANA timezone for North"));
    await user.type(screen.getByLabelText("IANA timezone for North"), "America/New_York");
    await user.clear(screen.getByLabelText("Local hour (0–23) for North"));
    await user.type(screen.getByLabelText("Local hour (0–23) for North"), "8");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([path, init]) => path === "/api/notifications" && init?.method === "PUT",
        ),
      ).toBe(true),
    );
    const call = request.mock.calls.find(
      ([path, init]) => path === "/api/notifications" && init?.method === "PUT",
    );
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.digests).toEqual([
      { brandId, enabled: true, timezone: "America/New_York", localHour: 8 },
    ]);
    expect(notificationSettingsUpdateSchema.parse(body)).toEqual(body);
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

  it("shows a bounded history and loads the next page only on request", async () => {
    const firstId = "b4d86cba-8b69-42d0-8c63-27f72603675a";
    const secondId = "18036429-00b8-4811-9c03-041f020a7df6";
    request.mockImplementation(async (path) => {
      if (path === "/api/notifications")
        return {
          enabled: true,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: true,
          digests: [],
        };
      if (path === "/api/notifications/events")
        return {
          events: [
            {
              id: firstId,
              event: "delivery_unknown",
              status: "attempted",
              createdAt: "2026-09-25T08:00:00.000Z",
              updatedAt: "2026-09-25T08:01:00.000Z",
            },
          ],
          nextCursor: firstId,
        };
      if (path === `/api/notifications/events?cursor=${firstId}`)
        return {
          events: [
            {
              id: secondId,
              event: "draft_ready",
              status: "sent",
              createdAt: "2026-09-24T08:00:00.000Z",
              updatedAt: "2026-09-24T08:01:00.000Z",
            },
          ],
          nextCursor: null,
        };
      throw new Error("unexpected request");
    });
    const user = userEvent.setup();
    render(<NotificationsPage />);
    expect(await screen.findByText("Delivery unconfirmed")).toBeInTheDocument();
    expect(screen.getByText("Publication outcome unknown")).toBeInTheDocument();
    expect(screen.getByText(/Last activity:/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalledWith(`/api/notifications/events?cursor=${firstId}`);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Draft ready")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
