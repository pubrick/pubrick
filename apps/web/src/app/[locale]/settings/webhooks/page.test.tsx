import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import { signedInSession } from "@/test/auth-client.stub";
import { render, screen, waitFor, within } from "@/test/render";
import WebhooksPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

const request = vi.mocked(api);
const secret = `whsec_${"a".repeat(43)}`;

describe("outgoing webhook settings", () => {
  beforeEach(() => {
    signedInSession();
    request.mockReset();
  });

  it("reveals the signing secret once and explains an unknown delivery", async () => {
    const user = userEvent.setup();
    let created = false;
    request.mockImplementation(async (path, init) => {
      if (path === "/api/webhooks" && init?.method === "POST") {
        created = true;
        return { id: "sub-1", name: "Automation", secret };
      }
      if (path === "/api/webhooks")
        return created
          ? [
              {
                id: "sub-1",
                name: "Automation",
                onSucceeded: true,
                onFailed: true,
                onUnknown: true,
                createdAt: "2026-09-24T12:00:00.000Z",
              },
            ]
          : [];
      if (path === "/api/webhooks/deliveries")
        return created
          ? [
              {
                id: "event-1",
                subscriptionId: "sub-1",
                publicationId: "pub-1",
                event: "publication.unknown",
                status: "unknown",
                attempts: 1,
                lastHttpStatus: null,
                createdAt: "2026-09-24T12:00:00.000Z",
              },
            ]
          : [];
      throw new Error("Unexpected request");
    });
    render(<WebhooksPage />);
    await screen.findByText("No webhooks yet");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const dialog = screen.getByRole("dialog", { name: "Add webhook" });
    await user.type(within(dialog).getByLabelText("Name"), "Automation");
    await user.type(
      within(dialog).getByLabelText("HTTPS endpoint"),
      "https://hooks.example.com/events",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    const payload = JSON.parse(
      String(
        request.mock.calls.find(
          ([path, init]) => path === "/api/webhooks" && init?.method === "POST",
        )?.[1]?.body,
      ),
    );
    expect(payload).toEqual({
      name: "Automation",
      url: "https://hooks.example.com/events",
      onSucceeded: true,
      onFailed: true,
      onUnknown: true,
    });
    expect(await screen.findByText(secret)).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText(secret)).not.toBeInTheDocument());
    expect(screen.getByText("event-1 · 1 attempt")).toBeInTheDocument();
    expect(screen.getByText(/Unknown means delivery may have reached/)).toBeInTheDocument();
  });

  it("explains owner-only access on a direct visit", async () => {
    request.mockRejectedValue(new ApiError(403, "Forbidden"));
    render(<WebhooksPage />, { locale: "ru" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Управлять вебхуками могут только владельцы и администраторы организации.",
    );
    expect(screen.queryByRole("button", { name: "Добавить" })).not.toBeInTheDocument();
  });
});
