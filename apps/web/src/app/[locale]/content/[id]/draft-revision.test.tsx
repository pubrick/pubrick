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
  sourceTitle: "Old headline",
  sourceBody: "First fact. Second fact.",
  instruction: "Make this flow better.",
  proposedTitle: "Clearer headline",
  proposal: "First fact leads into the second fact.",
  reason: "Connected the facts.",
  imagePlan: null,
};

beforeEach(() => {
  mockApi.mockReset();
  mockApiPage.mockReset();
  mockApiVoid.mockReset();
  mockApi.mockImplementation((url: string) =>
    Promise.resolve(url.endsWith("/images") ? { images: [], revision: 0 } : proposal),
  );
  mockApiPage.mockResolvedValue({ rows: [], nextCursor: null });
  mockApiVoid.mockResolvedValue(undefined);
});

describe("whole-draft revision", () => {
  it("sends an exact saved snapshot, compares both versions, and accepts explicitly", async () => {
    const accepted = vi.fn().mockResolvedValue(undefined);
    mockApi.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/images")
          ? { images: [], revision: 0 }
          : url.endsWith("/accept")
            ? { title: proposal.proposedTitle, body: proposal.proposal }
            : proposal,
      ),
    );
    render(
      <DraftRevision
        itemId="item-1"
        currentTitle={proposal.sourceTitle}
        currentBody={proposal.sourceBody}
        coverMediaId={null}
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
    const first = mockApi.mock.calls.find(([url]) => url === "/api/content/item-1/draft-revision");
    expect(first?.[0]).toBe("/api/content/item-1/draft-revision");
    expect(first?.[1]?.method).toBe("POST");
    const body = JSON.parse(first?.[1]?.body as string);
    expect(body).toEqual({
      expectedTitle: proposal.sourceTitle,
      expectedBody: proposal.sourceBody,
      instruction: proposal.instruction,
    });
    expect(draftRevisionRequestSchema.parse(body)).toEqual(body);
    expect(screen.getByText(proposal.sourceBody)).toBeInTheDocument();
    expect(screen.getByText(proposal.proposal)).toBeInTheDocument();
    expect(screen.getByText(proposal.sourceTitle)).toBeInTheDocument();
    expect(screen.getByText(proposal.proposedTitle)).toBeInTheDocument();
    expect(accepted).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(accepted).toHaveBeenCalledWith(proposal.proposal, proposal.proposedTitle),
    );
    expect(
      mockApi.mock.calls.some(
        ([url]) => url === `/api/content/item-1/draft-revision/${proposal.id}/accept`,
      ),
    ).toBe(true);
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
        currentTitle={proposal.sourceTitle}
        currentBody="Changed draft."
        coverMediaId={null}
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
    await waitFor(() =>
      expect(mockApi.mock.calls.some(([url]) => url === "/api/content/item-1/draft-revision")).toBe(
        true,
      ),
    );
    const body = JSON.parse(
      mockApi.mock.calls.find(([url]) => url === "/api/content/item-1/draft-revision")?.[1]
        ?.body as string,
    );
    expect(body).toEqual({
      expectedTitle: proposal.sourceTitle,
      expectedBody: "Changed draft.",
      noteId: note.id,
    });
    expect(draftRevisionRequestSchema.parse(body)).toEqual(body);
  });

  it("holds Accept when only the saved title changes", () => {
    render(
      <DraftRevision
        itemId="item-1"
        currentTitle="A title changed by another editor"
        currentBody={proposal.sourceBody}
        coverMediaId={null}
        draftBody={proposal.sourceBody}
        eligible
        staged={proposal}
        onAccepted={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(
      screen.getByText("The saved title or text changed. Discard this suggestion and ask again."),
    ).toBeInTheDocument();
  });

  it("keeps the provider refusal in the reader's language", async () => {
    const { ApiError } = await import("@/lib/api");
    mockApi.mockImplementation((url: string) =>
      url.endsWith("/images")
        ? Promise.resolve({ images: [], revision: 0 })
        : Promise.reject(new ApiError(409, "This draft changed", false, "draft_revision_stale")),
    );
    render(
      <DraftRevision
        itemId="item-1"
        currentTitle={proposal.sourceTitle}
        currentBody={proposal.sourceBody}
        coverMediaId={null}
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

  it("submits only checked image slots and previews generated assets before acceptance", async () => {
    const coverId = "28e318f3-e018-4da2-971a-b16eef17bcaa";
    const slotId = "d29ed5ad-fce8-475e-b48f-aa0532d6c462";
    const originalInlineId = "3c45f226-5b4f-4834-b12e-291531a82c55";
    const generatedId = "766607fb-ac55-496c-94ca-2b2b95a8aa7c";
    const imageProposal = {
      ...proposal,
      proposal: proposal.sourceBody,
      proposedTitle: proposal.sourceTitle,
      imagePlan: {
        sourceImagesRevision: 2,
        sourceCoverMediaId: coverId,
        textModelUsed: false,
        inFlight: null,
        selections: [
          {
            kind: "inline" as const,
            slotId,
            sourceMediaId: originalInlineId,
            afterParagraph: 0,
            generatedMediaId: generatedId,
          },
        ],
      },
    };
    mockApi.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/images")
          ? {
              revision: 2,
              images: [
                {
                  id: slotId,
                  mediaId: originalInlineId,
                  afterParagraph: 0,
                  alt: "Original",
                  caption: null,
                  alignment: "center",
                  needsReview: false,
                },
              ],
            }
          : imageProposal,
      ),
    );
    render(
      <DraftRevision
        itemId="item-1"
        currentTitle={proposal.sourceTitle}
        currentBody={proposal.sourceBody}
        coverMediaId={coverId}
        draftBody={proposal.sourceBody}
        eligible
        staged={null}
        onAccepted={vi.fn()}
      />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("checkbox", { name: /Illustration after paragraph 1/ }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Suggest rewrite" }));
    const requestCall = mockApi.mock.calls.find(
      ([url]) => url === "/api/content/item-1/draft-revision",
    );
    const body = JSON.parse(requestCall?.[1]?.body as string);
    expect(body).toEqual({
      expectedTitle: proposal.sourceTitle,
      expectedBody: proposal.sourceBody,
      expectedCoverMediaId: coverId,
      expectedImagesRevision: 2,
      regenerateImages: { cover: false, inlineSlotIds: [slotId] },
    });
    expect(draftRevisionRequestSchema.parse(body)).toEqual(body);
    expect(await screen.findByText("Generated images to review")).toBeInTheDocument();
    expect(screen.getByAltText("Illustration after paragraph 1")).toHaveAttribute(
      "src",
      `/api/media/${generatedId}/file`,
    );
  });

  it("shows a partial paid proposal after image failure and resumes only the missing slot", async () => {
    const slotId = "d29ed5ad-fce8-475e-b48f-aa0532d6c462";
    const sourceMediaId = "3c45f226-5b4f-4834-b12e-291531a82c55";
    const generatedId = "766607fb-ac55-496c-94ca-2b2b95a8aa7c";
    const partial = {
      ...proposal,
      instruction: "Regenerate selected images",
      proposedTitle: proposal.sourceTitle,
      proposal: proposal.sourceBody,
      imagePlan: {
        sourceImagesRevision: 2,
        sourceCoverMediaId: null,
        textModelUsed: false,
        inFlight: null,
        selections: [
          { kind: "inline", slotId, sourceMediaId, afterParagraph: 0, generatedMediaId: null },
        ],
      },
    };
    const completed = {
      ...partial,
      imagePlan: {
        ...partial.imagePlan,
        selections: [{ ...partial.imagePlan.selections[0], generatedMediaId: generatedId }],
      },
    };
    let attempts = 0;
    const { ApiError } = await import("@/lib/api");
    mockApi.mockImplementation((url: string) => {
      if (url.endsWith("/images"))
        return Promise.resolve({
          revision: 2,
          images: [
            {
              id: slotId,
              mediaId: sourceMediaId,
              afterParagraph: 0,
              alt: "Original",
              caption: null,
              alignment: "center",
              needsReview: false,
            },
          ],
        });
      if (url === "/api/content/item-1") return Promise.resolve({ draftRevisionProposal: partial });
      if (url.endsWith("/draft-revision")) {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new ApiError(409, "Image failed", false, "media_generation_failed"))
          : Promise.resolve(completed);
      }
      return Promise.resolve(undefined);
    });
    render(
      <DraftRevision
        itemId="item-1"
        currentTitle={proposal.sourceTitle}
        currentBody={proposal.sourceBody}
        coverMediaId={null}
        draftBody={proposal.sourceBody}
        eligible
        staged={null}
        onAccepted={vi.fn()}
      />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole("checkbox", { name: /Illustration after paragraph 1/ }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Suggest rewrite" }));
    const resume = await screen.findByRole("button", { name: "Resume missing images" });
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByText("Awaiting generation")).toBeInTheDocument();
    await userEvent.setup().click(resume);
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled());
    const posts = mockApi.mock.calls.filter(
      ([url]) => url === "/api/content/item-1/draft-revision",
    );
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1]?.[1]?.body as string)).toEqual({
      expectedTitle: proposal.sourceTitle,
      expectedBody: proposal.sourceBody,
      expectedCoverMediaId: null,
      expectedImagesRevision: 2,
      regenerateImages: { cover: false, inlineSlotIds: [slotId] },
    });
    expect(screen.getByAltText("Illustration after paragraph 1")).toHaveAttribute(
      "src",
      `/api/media/${generatedId}/file`,
    );
  });

  it("shows an image-loading error even when the draft has no cover", async () => {
    mockApi.mockRejectedValue(new Error("Image slots unavailable"));
    render(
      <DraftRevision
        itemId="item-1"
        currentTitle={proposal.sourceTitle}
        currentBody={proposal.sourceBody}
        coverMediaId={null}
        draftBody={proposal.sourceBody}
        eligible
        staged={null}
        onAccepted={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Attached images could not be loaded",
    );
  });

  it("blocks automatic retry when an image result may already be billed", async () => {
    const uncertain = {
      ...proposal,
      imagePlan: {
        sourceImagesRevision: 1,
        sourceCoverMediaId: null,
        textModelUsed: true,
        inFlight: {
          token: "7fdd56c0-ea72-47e0-927a-1c52b71f4ffb",
          startedAt: "2020-01-01T00:00:00.000Z",
          selection: 0,
        },
        selections: [
          {
            kind: "inline" as const,
            slotId: "d29ed5ad-fce8-475e-b48f-aa0532d6c462",
            sourceMediaId: "3c45f226-5b4f-4834-b12e-291531a82c55",
            afterParagraph: 0,
            generatedMediaId: null,
          },
        ],
      },
    };
    render(
      <DraftRevision
        itemId="item-1"
        currentTitle={proposal.sourceTitle}
        currentBody={proposal.sourceBody}
        coverMediaId={null}
        draftBody={proposal.sourceBody}
        eligible
        staged={uncertain}
        onAccepted={vi.fn()}
      />,
    );
    expect(screen.getByText(/last image call may already have been billed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume missing images" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
  });

  it("warns before accepting a shorter rewrite that moves an attached illustration", async () => {
    mockApi.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith("/images")
          ? {
              revision: 1,
              images: [
                {
                  id: "d29ed5ad-fce8-475e-b48f-aa0532d6c462",
                  mediaId: "3c45f226-5b4f-4834-b12e-291531a82c55",
                  afterParagraph: 1,
                  alt: "Second paragraph illustration",
                  caption: null,
                  alignment: "center",
                  needsReview: false,
                },
              ],
            }
          : proposal,
      ),
    );
    render(
      <DraftRevision
        itemId="item-1"
        currentTitle={proposal.sourceTitle}
        currentBody={proposal.sourceBody}
        coverMediaId={null}
        draftBody={proposal.sourceBody}
        eligible
        staged={proposal}
        onAccepted={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/Attached illustrations beyond its last paragraph will move there/),
    ).toBeInTheDocument();
  });
});
