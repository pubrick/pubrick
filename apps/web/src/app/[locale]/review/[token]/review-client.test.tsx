import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import ClientReviewPage from "./review-client";

const preview = {
  status: "pending",
  expiresAt: "2026-09-25T12:00:00.000Z",
  preview: {
    title: "Draft title",
    body: "Private draft body",
    channels: [{ name: "News", platform: "telegram", body: "Telegram version" }],
    coverUrl: null,
    videoUrl: null,
  },
  comment: null,
  reviewedAt: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("guest client review", () => {
  it("shows an attached video with explicit playback controls", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        ...preview,
        preview: { ...preview.preview, videoUrl: "/api/client-review/capability-token/video" },
      }),
    );
    render(<ClientReviewPage token="capability-token" />);
    const video = await screen.findByLabelText("Selected video for this draft");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "none");
    expect(video).toHaveAttribute("src", "/api/client-review/capability-token/video");
  });
  it("renders only the private saved preview and records a guest decision without credentials", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/verdict"))
        return jsonResponse(200, {
          status: "changes_requested",
          comment: "Correct the date",
          reviewedAt: "2026-09-23T12:00:00.000Z",
        });
      return jsonResponse(200, preview);
    });
    render(<ClientReviewPage token="capability-token" />);
    expect(await screen.findByText("Private draft body")).toBeInTheDocument();
    expect(screen.getByText("Telegram version")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Tell the team what needs to change.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.type(screen.getByRole("textbox", { name: /Comment/ }), "Correct the date");
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(await screen.findByText("Changes requested")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/client-review/capability-token",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/client-review/capability-token/verdict",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        body: JSON.stringify({ verdict: "changes_requested", comment: "Correct the date" }),
      }),
    );
  });

  it("does not render draft text from a closed capability", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(410, { error: "closed" }));
    render(<ClientReviewPage token="expired" />);
    await waitFor(() => expect(screen.getByText("This review link is closed")).toBeInTheDocument());
    expect(screen.queryByText("Private draft body")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve draft" })).not.toBeInTheDocument();
  });
});
