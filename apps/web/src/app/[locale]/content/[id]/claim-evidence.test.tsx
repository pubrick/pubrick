import { claimReviewStartSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiVoid } from "@/lib/api";
import { signedInSession } from "@/test/auth-client.stub";
import { act, renderAsync, screen, waitFor } from "@/test/render";
import en from "../../../../../messages/en.json";
import { ClaimEvidence } from "./claim-evidence";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
  apiVoid: vi.fn(),
}));

const request = vi.mocked(api);
const voidRequest = vi.mocked(apiVoid);
const itemId = "62229ae6-231e-4c71-bcc6-ab34fb3194e4";
const endpoint = `/api/content/${itemId}/claim-review`;
const correctionEndpoint = `/api/content/${itemId}/claim-correction`;
const historyEndpoint = `/api/content/${itemId}/claim-corrections`;
const body = "Revenue grew by 12% in 2026.";

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: "2fc5fc2d-94bc-4703-9cd2-f68eff876874",
    contentItemId: itemId,
    status: "ready",
    stale: false,
    claims: [
      {
        claim: "Revenue grew by 12% in 2026.",
        outcome: "insufficient",
        evidence: [
          {
            title: "Annual report",
            url: "https://example.org/report",
            snippet: "Revenue grew during the year.",
          },
        ],
      },
    ],
    errorCode: null,
    createdAt: "2026-09-25T00:00:00.000Z",
    startedAt: "2026-09-25T00:00:01.000Z",
    completedAt: "2026-09-25T00:00:03.000Z",
    ...overrides,
  };
}

function correction(overrides: Record<string, unknown> = {}) {
  return {
    id: "a3268aaf-491a-45bf-b0c6-c7409ce38aa7",
    contentItemId: itemId,
    reviewId: review().id,
    claimIndex: 0,
    sourceBody: body,
    claim: body,
    replacement: "Revenue grew by 8% in 2026.",
    reason: "The reported figure differs from the draft.",
    evidence: [
      { title: "Annual report", url: "https://example.org/report", snippet: "Revenue grew by 8%." },
    ],
    createdAt: "2026-09-25T00:00:04.000Z",
    ...overrides,
  };
}

function acceptedCorrection(overrides: Record<string, unknown> = {}) {
  return {
    id: "72192d8f-59a2-4d3e-9084-54bc8595213d",
    contentItemId: itemId,
    reviewId: review().id,
    fragmentVersionId: "035f7ee5-0c56-4dc9-a2d5-03e15e536f09",
    claimIndex: 0,
    sourceBodyHash: "a".repeat(64),
    claim: body,
    replacement: "Revenue grew by 8% in 2026.",
    reason: "The annual report gives a different number.",
    evidence: [
      {
        title: "Archived annual report",
        url: "https://example.org/archive",
        snippet: "Revenue grew by 8%.",
      },
    ],
    acceptedAt: "2026-09-25T01:00:00.000Z",
    ...overrides,
  };
}

describe("claim evidence", () => {
  beforeEach(() => {
    signedInSession();
    request.mockReset();
    voidRequest.mockReset();
    voidRequest.mockResolvedValue(undefined);
  });

  it("starts from the exact saved draft and displays advisory source results", async () => {
    let started = false;
    request.mockImplementation(async (path, options) => {
      if (path === correctionEndpoint) return null;
      if (options?.method === "POST") started = true;
      return started ? review() : null;
    });
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.ClaimEvidence.start }));
    await waitFor(() => expect(screen.getByText("Annual report")).toBeVisible());
    const [, options] = request.mock.calls.find(([, init]) => init?.method === "POST") ?? [];
    const payload = JSON.parse(String(options?.body));
    expect(payload).toEqual({ expectedBody: body });
    expect(claimReviewStartSchema.parse(payload)).toEqual(payload);
    expect(
      request.mock.calls.every(([path]) => path === endpoint || path === correctionEndpoint),
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Annual report" })).toHaveAttribute(
      "href",
      "https://example.org/report",
    );
    expect(screen.getByText(en.ClaimEvidence.outcome.insufficient)).toBeVisible();
  });

  it("marks a result as stale and stops a paid run while draft edits are unsaved", async () => {
    request.mockImplementation(async (path) =>
      path === correctionEndpoint ? null : review({ stale: true }),
    );
    await renderAsync(
      <ClaimEvidence itemId={itemId} savedBody={body} draftBody={`${body} Changed.`} editable />,
    );
    expect(await screen.findByText(en.ClaimEvidence.stale)).toBeVisible();
    expect(screen.getByRole("button", { name: en.ClaimEvidence.runAgain })).toBeDisabled();
    expect(request.mock.calls).toHaveLength(2);
  });

  it("does not suggest an unavailable check for a locked post", async () => {
    request.mockResolvedValue(null);
    await renderAsync(
      <ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable={false} />,
    );
    expect(await screen.findByText(en.ClaimEvidence.lockedHint)).toBeVisible();
    expect(screen.queryByText(en.ClaimEvidence.emptyHint)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.ClaimEvidence.start })).not.toBeInTheDocument();
  });

  it("refreshes the saved-body review after an edit is saved", async () => {
    let reads = 0;
    request.mockImplementation(async (path) =>
      path === correctionEndpoint ? null : review({ stale: ++reads > 1 }),
    );
    const { rerender } = await renderAsync(
      <ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />,
    );
    expect(await screen.findByText("Annual report")).toBeVisible();
    rerender(
      <ClaimEvidence
        itemId={itemId}
        savedBody={`${body} Updated.`}
        draftBody={`${body} Updated.`}
        editable
      />,
    );
    expect(await screen.findByText(en.ClaimEvidence.stale)).toBeVisible();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("keeps old evidence stale when a save completes before the POST reply", async () => {
    let reply!: (result: ReturnType<typeof review>) => void;
    let started = false;
    request.mockImplementation(async (path, options) => {
      if (path === correctionEndpoint) return null;
      if (options?.method === "POST") {
        started = true;
        return new Promise((resolve) => {
          reply = resolve;
        });
      }
      return started ? review({ stale: true }) : null;
    });
    const { rerender } = await renderAsync(
      <ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.ClaimEvidence.start }));
    rerender(
      <ClaimEvidence
        itemId={itemId}
        savedBody={`${body} Saved.`}
        draftBody={`${body} Saved.`}
        editable
      />,
    );
    expect(await screen.findByText(en.ClaimEvidence.stale)).toBeVisible();
    await act(async () => reply(review({ stale: false })));
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(6));
    expect(screen.getByText(en.ClaimEvidence.stale)).toBeVisible();
  });

  it("allows a fresh run while the previous body's job is still queued", async () => {
    request.mockImplementation(async (path) =>
      path === correctionEndpoint ? null : review({ status: "queued", stale: true }),
    );
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    expect(await screen.findByRole("button", { name: en.ClaimEvidence.runAgain })).toBeEnabled();
  });

  it("links to search setup when a key is missing", async () => {
    request.mockImplementation(async (path, options) => {
      if (path === correctionEndpoint) return null;
      if (options?.method === "POST")
        throw new ApiError(409, "Search key missing", false, "claim_review_no_search_key");
      return null;
    });
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.ClaimEvidence.start }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.ClaimEvidence.missingSearchKey);
    expect(screen.getByRole("link", { name: en.ClaimEvidence.settings })).toHaveAttribute(
      "href",
      "/en/settings/search",
    );
  });

  it("explains a missing key recorded by a failed background job", async () => {
    request.mockImplementation(async (path) =>
      path === correctionEndpoint ? null : review({ status: "failed", errorCode: "no_search_key" }),
    );
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    expect(await screen.findByText(en.ClaimEvidence.failure.no_search_key)).toBeVisible();
    expect(screen.getByRole("link", { name: en.ClaimEvidence.settings })).toHaveAttribute(
      "href",
      "/en/settings/search",
    );
  });

  it("does not make a non-web result URL clickable", async () => {
    request.mockImplementation(async (path) =>
      path === correctionEndpoint
        ? null
        : review({
            claims: [
              {
                claim: "Revenue grew by 12% in 2026.",
                outcome: "insufficient",
                evidence: [{ title: "Unsafe", url: "javascript:alert(1)", snippet: "Ignore" }],
              },
            ],
          }),
    );
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    expect(await screen.findByText(en.ClaimEvidence.outcome.insufficient)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Unsafe" })).not.toBeInTheDocument();
  });

  it("offers a paid suggestion only for a fresh conflicting claim with a web source", async () => {
    const conflicting = review({
      claims: [
        {
          claim: body,
          outcome: "evidence_conflicts",
          evidence: [
            {
              title: "Annual report",
              url: "https://example.org/report",
              snippet: "Revenue grew by 8%.",
            },
          ],
        },
        {
          claim: "A second claim",
          outcome: "insufficient",
          evidence: [{ title: "Source", url: "https://example.org/other", snippet: "No match." }],
        },
      ],
    });
    request.mockImplementation(async (path) => (path === correctionEndpoint ? null : conflicting));
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    expect(await screen.findByRole("button", { name: en.ClaimEvidence.propose })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: en.ClaimEvidence.propose })).toHaveLength(1);
    expect(screen.getByText(en.ClaimEvidence.proposalCostHint)).toBeVisible();
  });

  it("lets an author propose a correction without review or decision controls", async () => {
    const conflicting = review({
      claims: [{ claim: body, outcome: "evidence_conflicts", evidence: correction().evidence }],
    });
    request.mockImplementation(async (path, options) => {
      if (path === endpoint) return conflicting;
      if (path === correctionEndpoint && options?.method === "POST") return correction();
      if (path === correctionEndpoint) return null;
      throw new Error(`Unexpected API request: ${path}`);
    });
    await renderAsync(
      <ClaimEvidence
        itemId={itemId}
        savedBody={body}
        draftBody={body}
        editable
        canDecide={false}
      />,
    );
    expect(await screen.findByRole("button", { name: en.ClaimEvidence.propose })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: en.ClaimEvidence.runAgain }),
    ).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: en.ClaimEvidence.propose }));
    expect(
      await screen.findByRole("region", { name: en.ClaimEvidence.proposalTitle }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: en.ClaimEvidence.tryAgain })).toBeEnabled();
    expect(screen.queryByRole("button", { name: en.ClaimEvidence.accept })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: en.ClaimEvidence.discard }),
    ).not.toBeInTheDocument();
  });

  it("keeps evidence readable without offering paid correction for a manual draft", async () => {
    const conflicting = review({
      claims: [{ claim: body, outcome: "evidence_conflicts", evidence: correction().evidence }],
    });
    request.mockImplementation(async (path) => (path === correctionEndpoint ? null : conflicting));
    await renderAsync(
      <ClaimEvidence
        itemId={itemId}
        savedBody={body}
        draftBody={body}
        editable
        aiDraftEligible={false}
      />,
    );
    expect(await screen.findByText(en.ClaimEvidence.aiDraftOnly)).toBeVisible();
    expect(screen.getByRole("link", { name: "Annual report" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: en.ClaimEvidence.propose }),
    ).not.toBeInTheDocument();
  });

  it("stages a suggestion and accepts the saved-body change explicitly", async () => {
    const conflicting = review({
      claims: [{ claim: body, outcome: "evidence_conflicts", evidence: correction().evidence }],
    });
    const onAccepted = vi.fn(async (_updatedBody: string) => {});
    request.mockImplementation(async (path, options) => {
      if (path === endpoint) return conflicting;
      if (path === correctionEndpoint && options?.method === "POST") return correction();
      if (path === correctionEndpoint) return null;
      if (path === `${correctionEndpoint}/${correction().id}/accept`)
        return { body: correction().replacement };
      throw new Error(`Unexpected API request: ${path}`);
    });
    await renderAsync(
      <ClaimEvidence
        itemId={itemId}
        savedBody={body}
        draftBody={body}
        editable
        onAccepted={onAccepted}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.ClaimEvidence.propose }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: en.ClaimEvidence.proposalTitle })).toBeVisible(),
    );
    const [, options] =
      request.mock.calls.find(
        ([path, init]) => path === correctionEndpoint && init?.method === "POST",
      ) ?? [];
    expect(JSON.parse(String(options?.body))).toEqual({
      expectedBody: body,
      reviewId: conflicting.id,
      claimIndex: 0,
    });
    expect(screen.getByText(correction().replacement)).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Annual report" })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: en.ClaimEvidence.accept }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith(correction().replacement));
    expect(
      screen.queryByRole("region", { name: en.ClaimEvidence.proposalTitle }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(en.ClaimEvidence.accepted)).toBeVisible();
  });

  it("offers an explicitly paid retry while keeping the saved draft untouched", async () => {
    const conflicting = review({
      claims: [{ claim: body, outcome: "evidence_conflicts", evidence: correction().evidence }],
    });
    let proposals = 0;
    request.mockImplementation(async (path, options) => {
      if (path === endpoint) return conflicting;
      if (path === correctionEndpoint && options?.method === "POST") {
        proposals += 1;
        return correction({ replacement: `Replacement ${proposals}.` });
      }
      if (path === correctionEndpoint) return null;
      throw new Error(`Unexpected API request: ${path}`);
    });
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.ClaimEvidence.propose }));
    expect(await screen.findByText("Replacement 1.")).toBeVisible();
    expect(screen.getByText(en.ClaimEvidence.proposalCostHint)).toBeVisible();
    await user.click(screen.getByRole("button", { name: en.ClaimEvidence.tryAgain }));
    expect(await screen.findByText("Replacement 2.")).toBeVisible();
    expect(proposals).toBe(2);
    expect(screen.queryByText("Replacement 1.")).not.toBeInTheDocument();
  });

  it("blocks a paid suggestion for unsaved formatting and blocks accepting an older proposal", async () => {
    const conflicting = review({
      claims: [{ claim: body, outcome: "evidence_conflicts", evidence: correction().evidence }],
    });
    request.mockImplementation(async (path) => (path === correctionEndpoint ? null : conflicting));
    const { rerender } = await renderAsync(
      <ClaimEvidence
        itemId={itemId}
        savedBody={body}
        draftBody={body}
        editable
        unsavedFormatting
      />,
    );
    expect(await screen.findByRole("button", { name: en.ClaimEvidence.propose })).toBeDisabled();
    expect(
      request.mock.calls.some(
        ([path, init]) => path === correctionEndpoint && init?.method === "POST",
      ),
    ).toBe(false);

    request.mockImplementation(async (path) =>
      path === correctionEndpoint ? correction({ sourceBody: "Older draft" }) : conflicting,
    );
    rerender(
      <ClaimEvidence
        itemId={itemId}
        savedBody={`${body} Changed`}
        draftBody={`${body} Changed`}
        editable
      />,
    );
    expect(await screen.findByText(en.ClaimEvidence.proposalStale)).toBeVisible();
    expect(screen.getByRole("button", { name: en.ClaimEvidence.accept })).toBeDisabled();
    expect(screen.getByRole("button", { name: en.ClaimEvidence.discard })).toBeEnabled();
  });

  it("discards a staged correction without modifying the saved draft", async () => {
    const conflicting = review({
      claims: [{ claim: body, outcome: "evidence_conflicts", evidence: correction().evidence }],
    });
    const onAccepted = vi.fn(async (_updatedBody: string) => {});
    request.mockImplementation(async (path) => {
      if (path === endpoint) return conflicting;
      if (path === correctionEndpoint) return correction();
      throw new Error(`Unexpected API request: ${path}`);
    });
    await renderAsync(
      <ClaimEvidence
        itemId={itemId}
        savedBody={body}
        draftBody={body}
        editable
        onAccepted={onAccepted}
      />,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.ClaimEvidence.discard }));
    expect(await screen.findByText(en.ClaimEvidence.discarded)).toBeVisible();
    expect(voidRequest).toHaveBeenCalledWith(`${correctionEndpoint}/${correction().id}`, {
      method: "DELETE",
    });
    expect(onAccepted).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: en.ClaimEvidence.proposalTitle }),
    ).not.toBeInTheDocument();
  });

  it("warns before Accept when the master draft has rich formatting", async () => {
    const conflicting = review({
      claims: [{ claim: body, outcome: "evidence_conflicts", evidence: correction().evidence }],
    });
    request.mockImplementation(async (path) =>
      path === correctionEndpoint ? correction() : conflicting,
    );
    const { rerender } = await renderAsync(
      <ClaimEvidence
        itemId={itemId}
        savedBody={body}
        draftBody={body}
        editable
        hasRichFormatting
      />,
    );
    expect(await screen.findByText(en.ClaimEvidence.formattingReset)).toBeVisible();
    expect(screen.getByRole("button", { name: en.ClaimEvidence.accept })).toBeEnabled();
    rerender(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    expect(screen.queryByText(en.ClaimEvidence.formattingReset)).not.toBeInTheDocument();
  });

  it("loads accepted correction history only when opened and pages it once", async () => {
    const cursor = "0de22e04-07c2-4f3e-bbb7-d3efbd828a20";
    request.mockImplementation(async (path) => {
      if (path === endpoint) return review();
      if (path === correctionEndpoint) return null;
      if (path === historyEndpoint) return { rows: [acceptedCorrection()], nextCursor: cursor };
      if (path === `${historyEndpoint}?cursor=${cursor}`) {
        return {
          rows: [acceptedCorrection({ id: cursor, replacement: "A later correction." })],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    expect(request.mock.calls.some(([path]) => path.startsWith(historyEndpoint))).toBe(false);
    const user = userEvent.setup();
    await user.click(screen.getByText(en.ClaimEvidence.historyTitle));
    expect(await screen.findByText("Archived annual report")).toBeVisible();
    expect(screen.getByText(acceptedCorrection().reason)).toBeVisible();
    expect(screen.getByRole("link", { name: "Archived annual report" })).toHaveAttribute(
      "href",
      "https://example.org/archive",
    );
    await user.click(screen.getByRole("button", { name: en.ClaimEvidence.loadMore }));
    expect(await screen.findByText("A later correction.")).toBeVisible();
    expect(request.mock.calls.filter(([path]) => path.startsWith(historyEndpoint))).toHaveLength(2);
    await user.click(screen.getByText(en.ClaimEvidence.historyTitle));
    await user.click(screen.getByText(en.ClaimEvidence.historyTitle));
    expect(request.mock.calls.filter(([path]) => path.startsWith(historyEndpoint))).toHaveLength(2);
  });

  it("clears accepted history when the editor switches to another article", async () => {
    const anotherId = "a2f41fa3-bb34-465a-a3a9-114b0d26703c";
    request.mockImplementation(async (path) => {
      if (path === endpoint || path === `/api/content/${anotherId}/claim-review`) return null;
      if (path === correctionEndpoint || path === `/api/content/${anotherId}/claim-correction`)
        return null;
      if (path === historyEndpoint) return { rows: [acceptedCorrection()], nextCursor: null };
      if (path === `/api/content/${anotherId}/claim-corrections`)
        return {
          rows: [acceptedCorrection({ id: anotherId, claim: "A different article's claim." })],
          nextCursor: null,
        };
      throw new Error(`Unexpected API request: ${path}`);
    });
    const { rerender } = await renderAsync(
      <ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText(en.ClaimEvidence.historyTitle));
    expect(await screen.findByText(acceptedCorrection().reason)).toBeVisible();
    rerender(<ClaimEvidence itemId={anotherId} savedBody={body} draftBody={body} editable />);
    expect(await screen.findByText("A different article's claim.")).toBeVisible();
    expect(screen.queryByText(acceptedCorrection().claim)).not.toBeInTheDocument();
  });
});
