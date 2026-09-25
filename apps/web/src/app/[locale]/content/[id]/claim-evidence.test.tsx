import { claimReviewStartSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "@/lib/api";
import { signedInSession } from "@/test/auth-client.stub";
import { act, renderAsync, screen, waitFor } from "@/test/render";
import en from "../../../../../messages/en.json";
import { ClaimEvidence } from "./claim-evidence";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

const request = vi.mocked(api);
const itemId = "62229ae6-231e-4c71-bcc6-ab34fb3194e4";
const endpoint = `/api/content/${itemId}/claim-review`;
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

describe("claim evidence", () => {
  beforeEach(() => {
    signedInSession();
    request.mockReset();
  });

  it("starts from the exact saved draft and displays advisory source results", async () => {
    let started = false;
    request.mockImplementation(async (_path, options) => {
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
    expect(request.mock.calls.every(([path]) => path === endpoint)).toBe(true);
    expect(screen.getByRole("link", { name: "Annual report" })).toHaveAttribute(
      "href",
      "https://example.org/report",
    );
    expect(screen.getByText(en.ClaimEvidence.outcome.insufficient)).toBeVisible();
  });

  it("marks a result as stale and stops a paid run while draft edits are unsaved", async () => {
    request.mockResolvedValue(review({ stale: true }));
    await renderAsync(
      <ClaimEvidence itemId={itemId} savedBody={body} draftBody={`${body} Changed.`} editable />,
    );
    expect(await screen.findByText(en.ClaimEvidence.stale)).toBeVisible();
    expect(screen.getByRole("button", { name: en.ClaimEvidence.runAgain })).toBeDisabled();
    expect(request.mock.calls).toHaveLength(1);
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
    request.mockResolvedValueOnce(review()).mockResolvedValueOnce(review({ stale: true }));
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
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps old evidence stale when a save completes before the POST reply", async () => {
    let reply!: (result: ReturnType<typeof review>) => void;
    let started = false;
    request.mockImplementation(async (_path, options) => {
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
    await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(screen.getByText(en.ClaimEvidence.stale)).toBeVisible();
  });

  it("allows a fresh run while the previous body's job is still queued", async () => {
    request.mockResolvedValue(review({ status: "queued", stale: true }));
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    expect(await screen.findByRole("button", { name: en.ClaimEvidence.runAgain })).toBeEnabled();
  });

  it("links to search setup when a key is missing", async () => {
    request.mockImplementation(async (_path, options) => {
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
    request.mockResolvedValue(review({ status: "failed", errorCode: "no_search_key" }));
    await renderAsync(<ClaimEvidence itemId={itemId} savedBody={body} draftBody={body} editable />);
    expect(await screen.findByText(en.ClaimEvidence.failure.no_search_key)).toBeVisible();
    expect(screen.getByRole("link", { name: en.ClaimEvidence.settings })).toHaveAttribute(
      "href",
      "/en/settings/search",
    );
  });

  it("does not make a non-web result URL clickable", async () => {
    request.mockResolvedValue(
      review({
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
});
