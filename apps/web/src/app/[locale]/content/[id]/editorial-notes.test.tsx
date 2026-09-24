import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import { EditorialNotes } from "./editorial-notes";

const { mockApi, mockApiPage } = vi.hoisted(() => ({ mockApi: vi.fn(), mockApiPage: vi.fn() }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: mockApi, apiPage: mockApiPage };
});

beforeEach(() => {
  mockApi.mockReset();
  mockApiPage.mockReset();
  mockApiPage.mockResolvedValue({ rows: [], nextCursor: null });
});

describe("editorial notes", () => {
  it("sends a note against the saved text and shows its immutable history", async () => {
    const row = {
      id: "01b3ccf6-1535-469d-9f87-dc15f589f893",
      note: "Check the opening.",
      current: true,
      createdBy: "reviewer",
      authorName: "Ada",
      createdAt: "2026-09-24T10:00:00Z",
    };
    mockApi.mockResolvedValue(row);
    mockApiPage.mockResolvedValueOnce({ rows: [], nextCursor: null }).mockResolvedValueOnce({
      rows: [row],
      nextCursor: null,
    });
    render(<EditorialNotes itemId="item-1" currentBody="Saved body" draftBody="Saved body" />);
    await screen.findByText("No notes yet. Add one to record your feedback for the team.");
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Note" }), "Check the opening.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledOnce());
    expect(mockApi.mock.calls[0]?.[0]).toBe("/api/content/item-1/editorial-notes");
    expect(mockApi.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(mockApi.mock.calls[0]?.[1]?.body as string)).toEqual({
      note: "Check the opening.",
      expectedBody: "Saved body",
    });
    expect(await screen.findByText("Check the opening.")).toBeInTheDocument();
    expect(screen.getByText(/Current saved draft/)).toBeInTheDocument();
    expect(screen.getByText(/by Ada/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("");
  });

  it("holds the note until local edits are saved and marks older snapshots", async () => {
    mockApiPage.mockResolvedValue({
      rows: [
        {
          id: "01b3ccf6-1535-469d-9f87-dc15f589f893",
          note: "Check the opening.",
          current: false,
          createdBy: null,
          authorName: null,
          createdAt: "2026-09-24T10:00:00Z",
        },
      ],
      nextCursor: null,
    });
    render(<EditorialNotes itemId="item-1" currentBody="Saved body" draftBody="Unsaved body" />);
    expect(await screen.findByText(/Earlier saved draft/)).toBeInTheDocument();
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Note" }), "Check the ending.");
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
    expect(screen.getByText("Save your text before adding a note.")).toBeInTheDocument();
    expect(mockApi).not.toHaveBeenCalled();
  });
});
