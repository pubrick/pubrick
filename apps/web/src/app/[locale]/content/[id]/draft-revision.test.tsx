import { draftRevisionRequestSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import { DraftRevision } from "./draft-revision";

const { mockApi, mockApiPage, mockApiVoid } = vi.hoisted(() => ({
  mockApi: vi.fn(),
  mockApiPage: vi.fn(),
  mockApiVoid: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: mockApi, apiPage: mockApiPage, apiVoid: mockApiVoid };
});

const proposal = {
  id: "01b3ccf6-1535-469d-9f87-dc15f589f893",
  sourceBody: "First fact. Second fact.",
  instruction: "Make this flow better.",
  proposal: "First fact leads into the second fact.",
  reason: "Connected the facts.",
};

beforeEach(() => {
  mockApi.mockReset();
  mockApiPage.mockReset();
  mockApiVoid.mockReset();
  mockApi.mockResolvedValue(proposal);
  mockApiPage.mockResolvedValue({ rows: [], nextCursor: null });
  mockApiVoid.mockResolvedValue(undefined);
});

describe("whole-draft revision", () => {
  it("sends an exact saved snapshot, compares both versions, and accepts explicitly", async () => {
    const accepted = vi.fn().mockResolvedValue(undefined);
    mockApi.mockResolvedValueOnce(proposal).mockResolvedValueOnce({ body: proposal.proposal });
    render(
      <DraftRevision
        itemId="item-1"
        currentBody={proposal.sourceBody}
        draftBody={proposal.sourceBody}
        eligible
        staged={null}
        onAccepted={accepted}
      />,
    );
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Revision instruction" }), proposal.instruction);
    await userEvent.setup().click(screen.getByRole("button", { name: "Suggest rewrite" }));
    await screen.findByRole("region", { name: "Whole-draft suggestion" });
    const first = mockApi.mock.calls[0];
    expect(first?.[0]).toBe("/api/content/item-1/draft-revision");
    expect(first?.[1]?.method).toBe("POST");
    const body = JSON.parse(first?.[1]?.body as string);
    expect(body).toEqual({ expectedBody: proposal.sourceBody, instruction: proposal.instruction });
    expect(draftRevisionRequestSchema.parse(body)).toEqual(body);
    expect(screen.getByText(proposal.sourceBody)).toBeInTheDocument();
    expect(screen.getByText(proposal.proposal)).toBeInTheDocument();
    expect(accepted).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(accepted).toHaveBeenCalledWith(proposal.proposal));
    expect(mockApi.mock.calls[1]?.[0]).toBe(
      `/api/content/item-1/draft-revision/${proposal.id}/accept`,
    );
  });

  it("uses a saved current note and holds Accept when the draft moves", async () => {
    const note = {
      id: "c601869e-4dc3-4d32-84bf-f50044450aaa",
      note: "Make this flow better.",
      current: true,
      createdBy: null,
      authorName: null,
      createdAt: "2026-09-24T10:00:00Z",
    };
    mockApiPage.mockResolvedValue({ rows: [note], nextCursor: null });
    render(
      <DraftRevision
        itemId="item-1"
        currentBody="Changed draft."
        draftBody="Changed draft."
        eligible
        staged={proposal}
        onAccepted={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Use team note" }));
    await screen.findByRole("option", { name: note.note });
    await userEvent
      .setup()
      .selectOptions(screen.getByRole("combobox", { name: "Choose a current note" }), note.id);
    await userEvent.setup().click(screen.getByRole("button", { name: "Suggest rewrite" }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledOnce());
    const body = JSON.parse(mockApi.mock.calls[0]?.[1]?.body as string);
    expect(body).toEqual({ expectedBody: "Changed draft.", noteId: note.id });
    expect(draftRevisionRequestSchema.parse(body)).toEqual(body);
  });

  it("keeps the provider refusal in the reader's language", async () => {
    const { ApiError } = await import("@/lib/api");
    mockApi.mockRejectedValue(
      new ApiError(409, "This draft changed", false, "draft_revision_stale"),
    );
    render(
      <DraftRevision
        itemId="item-1"
        currentBody={proposal.sourceBody}
        draftBody={proposal.sourceBody}
        eligible
        staged={null}
        onAccepted={vi.fn()}
      />,
      { locale: "es" },
    );
    await userEvent
      .setup()
      .type(screen.getByRole("textbox", { name: "Instrucción de revisión" }), "Ajusta el tono");
    await userEvent.setup().click(screen.getByRole("button", { name: "Sugerir reescritura" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "El borrador o la nota seleccionada cambió",
    );
  });
});
