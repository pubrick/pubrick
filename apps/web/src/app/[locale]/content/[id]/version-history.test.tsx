import { type ContentVersionDto, contentVersionRestoreSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiPage } from "@/lib/api";
import { render, screen, waitFor } from "@/test/render";
import { VersionHistory } from "./version-history";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn(), apiPage: vi.fn() };
});

const mockApi = vi.mocked(api);
const mockApiPage = vi.mocked(apiPage);
const version: ContentVersionDto = {
  id: "11111111-1111-4111-8111-111111111111",
  adaptationId: null,
  body: "An older saved draft.",
  origin: "human",
  createdAt: "2026-09-01T10:00:00.000Z",
};

beforeEach(() => {
  mockApi.mockReset();
  mockApiPage.mockReset();
  mockApiPage.mockResolvedValue({ rows: [version], nextCursor: null });
  mockApi.mockResolvedValue({});
});

describe("VersionHistory", () => {
  it("loads on disclosure and restores a preview only after confirmation", async () => {
    const user = userEvent.setup();
    const onRestored = vi.fn().mockResolvedValue(undefined);
    render(
      <VersionHistory
        itemId="22222222-2222-4222-8222-222222222222"
        currentBody="Current text."
        draftBody="Current text."
        editable
        onRestored={onRestored}
      />,
    );
    expect(mockApiPage).not.toHaveBeenCalled();
    await user.click(screen.getByText("Version history"));
    await screen.findByText(/Human edit/);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText(version.body)).toBeInTheDocument();
    expect(mockApi).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Restore this text" }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(version.body));
    expect(mockApi).toHaveBeenCalledWith(
      `/api/content/22222222-2222-4222-8222-222222222222/versions/${version.id}/restore`,
      { method: "POST", body: JSON.stringify({ expectedBody: "Current text." }) },
    );
    const requestBody = mockApi.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe("string");
    if (typeof requestBody !== "string") throw new Error("Restore body was not sent");
    const sent = JSON.parse(requestBody) as Record<string, unknown>;
    expect(contentVersionRestoreSchema.parse(sent)).toEqual(sent);
    expect(screen.getByRole("status")).toHaveTextContent("Saved version restored.");
  });

  it("keeps unsaved override text and requires a saved draft before restore", async () => {
    const user = userEvent.setup();
    render(
      <VersionHistory
        itemId="22222222-2222-4222-8222-222222222222"
        adaptationId="33333333-3333-4333-8333-333333333333"
        currentBody={null}
        draftBody="Unsaved override"
        editable
        onRestored={vi.fn()}
      />,
    );
    await user.click(screen.getByText("Version history"));
    expect(
      await screen.findByText("Save your current edits before restoring a version."),
    ).toBeInTheDocument();
    expect(mockApiPage).toHaveBeenCalledWith(
      "/api/content/22222222-2222-4222-8222-222222222222/versions?adaptationId=33333333-3333-4333-8333-333333333333",
    );
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("button", { name: "Restore this text" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Save your current edits before restoring a version.",
    );
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("translates a stale restore refusal and leaves the current text untouched", async () => {
    mockApi.mockRejectedValue(new ApiError(409, "Changed", false, "version_changed"));
    const user = userEvent.setup();
    const onRestored = vi.fn();
    render(
      <VersionHistory
        itemId="22222222-2222-4222-8222-222222222222"
        currentBody="Current text."
        draftBody="Current text."
        editable
        onRestored={onRestored}
      />,
      { locale: "ru" },
    );
    await user.click(screen.getByText("История версий"));
    await user.click(await screen.findByRole("button", { name: "Посмотреть" }));
    await user.click(screen.getByRole("button", { name: "Восстановить текст" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Сохранённый текст изменился");
    expect(onRestored).not.toHaveBeenCalled();
  });
});
