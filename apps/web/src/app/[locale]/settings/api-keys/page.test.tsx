import { apiKeyCreateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import { signedInSession } from "@/test/auth-client.stub";
import { render, screen, waitFor, within } from "@/test/render";
import ApiKeysPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

const request = vi.mocked(api);
const keyId = "eb71ec95-6534-4e4e-b96d-14600358ec7d";
const key = "pbrk_0123456789abcdef01234567_0123456789abcdefghijklmnopqrstuvwxyzABCDE";

describe("API key settings", () => {
  beforeEach(() => {
    signedInSession();
    request.mockReset();
  });

  it("shows the secret only in the create dialog and sends the validated scope", async () => {
    const user = userEvent.setup();
    const listed = {
      id: keyId,
      name: "Automation",
      prefix: "0123456789abcdef01234567",
      scope: "content:read",
      createdAt: "2026-09-24T00:00:00.000Z",
      revokedAt: null,
    };
    let created = false;
    request.mockImplementation(async (path, init) => {
      if (path === "/api/api-keys" && !init) return created ? [listed] : [];
      if (path === "/api/api-keys" && init?.method === "POST") {
        created = true;
        return { ...listed, key };
      }
      throw new Error("Unexpected request");
    });
    render(<ApiKeysPage />);
    await screen.findByText("No API keys yet");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const dialog = screen.getByRole("dialog", { name: "Add API key" });
    await user.type(within(dialog).getByLabelText("Name"), "Automation");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    const payload = JSON.parse(
      String(
        request.mock.calls.find(
          ([path, init]) => path === "/api/api-keys" && init?.method === "POST",
        )?.[1]?.body,
      ),
    );
    expect(payload).toEqual({ name: "Automation", scope: "content:read" });
    expect(apiKeyCreateSchema.parse(payload)).toEqual(payload);
    expect(await screen.findByText(key)).toBeInTheDocument();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText(key)).not.toBeInTheDocument());
    expect(screen.getByText(/0123456789abcdef01234567/)).toBeInTheDocument();
  });

  it("explains owner-only access on a direct visit", async () => {
    request.mockRejectedValue(new ApiError(403, "You don't have access to this."));
    render(<ApiKeysPage />, { locale: "ru" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Управлять ключами API могут только владелец и администраторы организации.",
    );
    expect(screen.queryByRole("button", { name: "Добавить" })).not.toBeInTheDocument();
  });
});
