import { notificationSettingsUpdateSchema, notificationSummarySchema } from "@pubrick/shared";
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
const emptySummary = (days: 7 | 30) => ({
  days,
  windowStart: "2030-01-24T12:00:00.000Z",
  windowEnd: "2030-01-31T12:00:00.000Z",
  total: 0,
  byEvent: { draft_ready: 0, delivery_failed: 0, delivery_unknown: 0, morning_digest: 0 },
  byStatus: { pending: 0, attempted: 0, sent: 0, failed: 0, skipped: 0 },
  byReason: {
    destination_disabled: 0,
    event_disabled: 0,
    subject_unavailable: 0,
    origin_invalid: 0,
    preflight_failed: 0,
    provider_rejected: 0,
    delivery_unconfirmed: 0,
  },
  withoutReason: 0,
});

describe("notifications settings", () => {
  beforeEach(() => {
    signedInSession();
    request.mockReset();
    request.mockImplementation(async (path, init) => {
      if (path === "/api/notifications/summary?days=7") return emptySummary(7);
      if (path === "/api/notifications/summary?days=30") return emptySummary(30);
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

  it("shows a translated zero summary and switches the bounded period", async () => {
    render(<NotificationsPage />, { locale: "ru" });
    expect(await screen.findByText("За этот период уведомлений нет.")).toBeVisible();
    expect(
      screen.getByText("Включите уведомления выше, чтобы получать записи о доставке."),
    ).toBeVisible();
    expect(request).toHaveBeenCalledWith("/api/notifications/summary?days=7");
    await userEvent.setup().click(screen.getByRole("tab", { name: "30 дней" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/notifications/summary?days=30"));
  });

  it("labels unconfirmed attempts separately from failed and skipped outcomes", async () => {
    const payload = {
      ...emptySummary(7),
      total: 3,
      byEvent: { draft_ready: 1, delivery_failed: 1, delivery_unknown: 1, morning_digest: 0 },
      byStatus: { pending: 0, attempted: 1, sent: 0, failed: 1, skipped: 1 },
      byReason: { ...emptySummary(7).byReason, delivery_unconfirmed: 1, provider_rejected: 1 },
      withoutReason: 1,
    };
    expect(notificationSummarySchema.parse(payload)).toEqual(payload);
    request.mockImplementation(async (path) => {
      if (path === "/api/notifications/summary?days=7") return payload;
      if (path === "/api/notifications")
        return {
          enabled: true,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: true,
          digests: [],
        };
      if (path === "/api/notifications/events") return { events: [], nextCursor: null };
      throw new Error("unexpected request");
    });
    render(<NotificationsPage />, { locale: "es" });
    expect(await screen.findByRole("heading", { name: "Resumen de entregas" })).toBeVisible();
    expect(screen.getAllByText("Entrega sin confirmar").length).toBeGreaterThan(0);
    expect(screen.getByText("Entrega fallida")).toBeVisible();
    expect(screen.getByText("Omitido")).toBeVisible();
    expect(screen.getByText("Telegram rechazó")).toBeVisible();
    expect(screen.getByText("Sin motivo de diagnóstico")).toBeVisible();
    expect(screen.getByText(/puede estar en el chat de Telegram/)).toBeVisible();
  });

  it("shows a translated summary error and retries without relaying provider prose", async () => {
    let attempts = 0;
    request.mockImplementation(async (path) => {
      if (path === "/api/notifications/summary?days=7") {
        attempts += 1;
        if (attempts === 1) throw new Error("private provider response");
        return emptySummary(7);
      }
      if (path === "/api/notifications")
        return {
          enabled: false,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: false,
          digests: [],
        };
      if (path === "/api/notifications/events") return { events: [], nextCursor: null };
      throw new Error("unexpected request");
    });
    render(<NotificationsPage />, { locale: "ru" });
    const error = await screen.findByRole("alert");
    expect(error).toHaveTextContent("Не удалось загрузить сводку доставки.");
    expect(error).not.toHaveTextContent("private provider response");
    await userEvent.setup().click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("За этот период уведомлений нет.")).toBeVisible();
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
      if (path === "/api/notifications/summary?days=7") return emptySummary(7);
      if (path === "/api/notifications/summary?days=30") return emptySummary(30);
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
      if (path === "/api/notifications/summary?days=7") return emptySummary(7);
      if (path === "/api/notifications/summary?days=30") return emptySummary(30);
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
    expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
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
    expect(await screen.findByRole("button", { name: "Send now" })).toBeEnabled();
  });

  it("queues a saved brand digest from its one action and reports duplicate admission", async () => {
    const brandId = "7b72825b-71e1-49fa-8764-2472c9d965f9";
    request.mockImplementation(async (path, init) => {
      if (path === "/api/notifications/summary?days=7") return emptySummary(7);
      if (path === "/api/notifications/summary?days=30") return emptySummary(30);
      if (path === "/api/notifications" && !init)
        return {
          enabled: true,
          draftReady: false,
          deliveryProblem: true,
          hasCredentials: true,
          digests: [{ brandId, brandName: "North", enabled: true, timezone: "UTC", localHour: 9 }],
        };
      if (path === "/api/notifications/events") return { events: [], nextCursor: null };
      if (path === `/api/notifications/digests/${brandId}/send` && init?.method === "POST")
        return { status: "already_queued" };
      throw new Error("unexpected request");
    });
    const user = userEvent.setup();
    render(<NotificationsPage />);
    const send = await screen.findByRole("button", { name: "Send now" });
    await user.type(screen.getByLabelText("Bot token"), "123:new");
    expect(send).toBeDisabled();
    await user.clear(screen.getByLabelText("Bot token"));
    await user.type(screen.getByLabelText("Destination chat ID"), "-10099");
    expect(send).toBeDisabled();
    await user.clear(screen.getByLabelText("Destination chat ID"));
    expect(send).toBeEnabled();
    await user.click(send);
    expect(await screen.findByRole("status")).toHaveTextContent("already queued for today");
    expect(request).toHaveBeenCalledWith(`/api/notifications/digests/${brandId}/send`, {
      method: "POST",
    });
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
      if (path === "/api/notifications/summary?days=7") return emptySummary(7);
      if (path === "/api/notifications/summary?days=30") return emptySummary(30);
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
              reason: "delivery_unconfirmed",
              createdAt: "2026-09-25T08:00:00.000Z",
              attemptedAt: "2026-09-25T08:01:00.000Z",
              updatedAt: "2026-09-25T08:01:00.000Z",
              related: { kind: "post", id: firstId },
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
              reason: null,
              createdAt: "2026-09-24T08:00:00.000Z",
              attemptedAt: "2026-09-24T08:01:00.000Z",
              updatedAt: "2026-09-24T08:01:00.000Z",
              related: null,
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
    expect(screen.getByText(/First attempt:/)).toBeInTheDocument();
    expect(
      screen.getByText(/Pubrick will not send this alert again automatically/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open post" })).toHaveAttribute(
      "href",
      `/en/content/${firstId}`,
    );
    expect(request).not.toHaveBeenCalledWith(`/api/notifications/events?cursor=${firstId}`);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Draft ready")).toBeInTheDocument();
    expect(screen.getByText("Related record is no longer available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
