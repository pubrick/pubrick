import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { render, screen } from "@/test/render";
import en from "../../../../../../messages/en.json";
import { AutoComments } from "./auto-comments";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("automatic comment setting", () => {
  beforeEach(() => {
    signedInSession();
  });

  it("shows a recoverable load error and retries without a primary action", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(response(200, { enabled: false, updatedAt: null }));
    vi.stubGlobal("fetch", fetcher);
    render(<AutoComments brandId="7c5d37a7-fde5-4118-a5a1-2272a3e88e4a" telegramConnected />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.Sources.autoCommentsRetry }));
    expect(await screen.findByText(en.Sources.autoCommentsOff)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not render controls without brand permission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(403, { message: "Forbidden" })));
    render(<AutoComments brandId="7c5d37a7-fde5-4118-a5a1-2272a3e88e4a" telegramConnected />);
    expect(
      screen.queryByRole("button", { name: en.Sources.autoCommentsEnable }),
    ).not.toBeInTheDocument();
  });
});
