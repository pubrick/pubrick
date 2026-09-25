import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, waitFor } from "@/test/render";
import { AutopilotScheduledChecks } from "./scheduled-checks";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const firstId = "17e2f639-e45b-42bb-a8a9-e4f06b9ef193";
const secondId = "28d3a420-f51a-4cf8-b35e-770329c7d0dd";

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("scheduled Autopilot checks", () => {
  beforeEach(() => {
    signedInSession();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("distinguishes dispatch admission from completion and supports filter plus cursor", async () => {
    const urls: string[] = [];
    const intervals = vi.spyOn(window, "setInterval");
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("cursor="))
        return response({
          rows: [
            {
              id: secondId,
              status: "skipped",
              decision: "no_approved_topic",
              runId: null,
              startedAt: "2026-09-25T09:00:00.000Z",
              finishedAt: "2026-09-25T09:00:01.000Z",
            },
          ],
          nextCursor: null,
        });
      if (url.includes("status=failed")) return response({ rows: [], nextCursor: null });
      return response({
        rows: [
          {
            id: firstId,
            status: "dispatched",
            decision: "dispatched",
            runId: "b796870b-3a40-45d7-ac03-2f5860d11552",
            startedAt: "2026-09-25T10:00:00.000Z",
            finishedAt: "2026-09-25T10:00:01.000Z",
          },
        ],
        nextCursor: firstId,
      });
    });
    await renderAsync(<AutopilotScheduledChecks brandId={brandId} />);
    expect(await screen.findByText("Sent for generation")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sent for draft generation" })).toHaveAttribute(
      "href",
      "/en/content/runs/b796870b-3a40-45d7-ac03-2f5860d11552",
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("No approved undated topic is ready")).toBeInTheDocument();
    const requestsBeforePoll = urls.length;
    const poll = intervals.mock.calls.find(([, ms]) => ms === 30_000)?.[0];
    expect(poll).toBeDefined();
    act(() => {
      if (typeof poll === "function") poll();
    });
    expect(urls).toHaveLength(requestsBeforePoll);
    expect(screen.getByText("No approved undated topic is ready")).toBeInTheDocument();
    await userEvent
      .setup()
      .selectOptions(screen.getByRole("combobox", { name: "Decision" }), "failed");
    await waitFor(() => expect(urls.some((url) => url.includes("status=failed"))).toBe(true));
    expect(await screen.findByText("No scheduled checks yet.")).toBeInTheDocument();
    intervals.mockRestore();
  });

  it.each(["filter", "brand"] as const)(
    "ignores an older page that settles after the %s changes",
    async (change) => {
      const otherBrandId = "ec113540-f988-45bc-a0d8-214416143106";
      let resolveOlder!: (value: Response) => void;
      const olderPage = new Promise<Response>((resolve) => {
        resolveOlder = resolve;
      });
      const urls: string[] = [];
      vi.mocked(fetch).mockImplementation((input) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("cursor=")) return olderPage;
        if (url.includes("status=failed") || url.includes(otherBrandId))
          return Promise.resolve(response({ rows: [], nextCursor: null }));
        return Promise.resolve(
          response({
            rows: [
              {
                id: firstId,
                status: "dispatched",
                decision: "dispatched",
                runId: null,
                startedAt: "2026-09-25T10:00:00.000Z",
                finishedAt: "2026-09-25T10:00:01.000Z",
              },
            ],
            nextCursor: firstId,
          }),
        );
      });
      const view = await renderAsync(<AutopilotScheduledChecks brandId={brandId} />);
      await screen.findByText("Sent for draft generation");
      await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
      await waitFor(() => expect(urls.some((url) => url.includes("cursor="))).toBe(true));
      if (change === "filter") {
        await userEvent
          .setup()
          .selectOptions(screen.getByRole("combobox", { name: "Decision" }), "failed");
      } else {
        view.rerender(<AutopilotScheduledChecks brandId={otherBrandId} />);
      }
      expect(await screen.findByText("No scheduled checks yet.")).toBeInTheDocument();
      await act(async () => {
        resolveOlder(
          response({
            rows: [
              {
                id: secondId,
                status: "skipped",
                decision: "no_approved_topic",
                runId: null,
                startedAt: "2026-09-25T09:00:00.000Z",
                finishedAt: "2026-09-25T09:00:01.000Z",
              },
            ],
            nextCursor: null,
          }),
        );
      });
      expect(screen.queryByText("No approved undated topic is ready")).not.toBeInTheDocument();
      expect(screen.getByText("No scheduled checks yet.")).toBeInTheDocument();
    },
  );
});
