import { searchCredentialUpsertSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiVoid } from "@/lib/api";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../messages/en.json";
import SearchSettingsPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
  apiVoid: vi.fn(),
}));

const request = vi.mocked(api);
const requestVoid = vi.mocked(apiVoid);
const empty = { configured: false, folderId: null, updatedAt: null };
const saved = {
  configured: true,
  folderId: "b1gfexamplefolder123",
  updatedAt: "2026-09-25T00:00:00.000Z",
};

describe("search key settings", () => {
  beforeEach(() => {
    signedInSession();
    request.mockReset();
    requestVoid.mockReset();
  });

  it("saves a scoped key without showing it again or making a search request", async () => {
    request.mockImplementation(async (_path, options) =>
      options?.method === "PUT" ? saved : empty,
    );
    await renderAsync(<SearchSettingsPage />);
    expect(await screen.findByText(en.SearchSettings.notConfigured)).toBeVisible();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.SearchSettings.folderId), saved.folderId);
    const key = "AQVN-search-private-key";
    await user.type(screen.getByLabelText(en.SearchSettings.apiKey), key);
    await user.click(screen.getByRole("button", { name: en.SearchSettings.save }));
    expect(await screen.findByRole("status")).toHaveTextContent(en.SearchSettings.saved);
    expect(screen.getByLabelText(en.SearchSettings.apiKey)).toHaveValue("");
    expect(document.body).not.toHaveTextContent(key);
    const [, options] = request.mock.calls.find(([, init]) => init?.method === "PUT") ?? [];
    const payload = JSON.parse(String(options?.body));
    expect(payload).toEqual({ apiKey: key, folderId: saved.folderId });
    expect(searchCredentialUpsertSchema.parse(payload)).toEqual(payload);
    expect(request.mock.calls.every(([path]) => path === "/api/search-credentials")).toBe(true);
  });

  it("removes a saved key only after confirmation", async () => {
    request.mockResolvedValue(saved);
    requestVoid.mockResolvedValue(undefined);
    await renderAsync(<SearchSettingsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.SearchSettings.remove }));
    expect(requestVoid).not.toHaveBeenCalled();
    const dialog = within(screen.getByRole("dialog", { name: en.SearchSettings.removeTitle }));
    await user.click(dialog.getByRole("button", { name: en.SearchSettings.remove }));
    await waitFor(() =>
      expect(requestVoid).toHaveBeenCalledWith("/api/search-credentials", { method: "DELETE" }),
    );
    expect(screen.getByText(en.SearchSettings.notConfigured)).toBeVisible();
  });

  it("explains access restrictions without offering key actions", async () => {
    request.mockRejectedValue(new ApiError(403, "Forbidden"));
    await renderAsync(<SearchSettingsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.SearchSettings.managerOnly);
    expect(screen.queryByRole("button", { name: en.SearchSettings.save })).not.toBeInTheDocument();
  });

  it("guides a signed-in user without a workspace to onboarding", async () => {
    request.mockRejectedValue(
      new ApiError(403, "No active organization", true, "no_active_organization"),
    );
    await renderAsync(<SearchSettingsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.Errors.no_active_organization);
    expect(screen.queryByText(en.SearchSettings.managerOnly)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.SearchSettings.onboarding })).toHaveAttribute(
      "href",
      "/en/onboarding",
    );
    expect(screen.queryByRole("button", { name: en.SearchSettings.save })).not.toBeInTheDocument();
  });
});
