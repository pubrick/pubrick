import { publicationCommentCollectionUpdateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { render, screen, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import es from "../../../../../../messages/es.json";
import { AutoReplies } from "./auto-replies";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("automatic publication reply setting", () => {
  beforeEach(() => signedInSession());

  it("requires a localized confirmation and sends the exact validated opt-in body", async () => {
    const settings = [
      response(200, { enabled: false, updatedAt: null }),
      response(200, { enabled: true, updatedAt: "2026-09-25T00:00:00.000Z" }),
      response(200, { enabled: false, updatedAt: "2026-09-25T00:01:00.000Z" }),
    ];
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/telegram-connection")) return response(200, { connected: true });
      const next = settings.shift();
      if (!next) throw new Error("Unexpected settings request");
      return next;
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AutoReplies brandId={brandId} />);
    expect(await screen.findByText(en.Analytics.autoRepliesOff)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: en.Analytics.autoRepliesEnable }));
    expect(screen.getByRole("dialog")).toHaveTextContent(en.Analytics.autoRepliesConfirmBody);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: en.Analytics.autoRepliesEnable,
      }),
    );
    expect(await screen.findByText(en.Analytics.autoRepliesOn)).toBeInTheDocument();
    const [url, request] = fetcher.mock.calls.find(([, init]) => init?.method === "PUT") as [
      string,
      RequestInit,
    ];
    expect(url).toContain(`/api/analytics/brands/${brandId}/comment-collection`);
    expect(request.method).toBe("PUT");
    expect(JSON.parse(String(request.body))).toEqual({ enabled: true });
    expect(
      publicationCommentCollectionUpdateSchema.parse(JSON.parse(String(request.body))),
    ).toEqual({ enabled: true });
    await userEvent.click(screen.getByRole("button", { name: en.Analytics.autoRepliesDisable }));
    expect(await screen.findByText(en.Analytics.autoRepliesOff)).toBeInTheDocument();
    const disable = fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")[1];
    expect(JSON.parse(String(disable?.[1]?.body))).toEqual({
      enabled: false,
    });
  });

  it("explains why enabled collection is waiting without a connected Telegram account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/telegram-connection")
          ? response(200, { connected: false })
          : response(200, { enabled: true, updatedAt: "2026-09-25T00:00:00.000Z" }),
      ),
    );
    render(<AutoReplies brandId={brandId} />);
    expect(await screen.findByText(en.Analytics.autoRepliesOn)).toBeInTheDocument();
    expect(screen.getByText(en.Analytics.autoRepliesWaitingConnection)).toBeInTheDocument();
  });

  it("shows a Spanish load failure and offers a retry", async () => {
    let attempts = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/telegram-connection")) return response(200, { connected: true });
      attempts++;
      if (attempts === 1) throw new Error("offline");
      return response(200, { enabled: false, updatedAt: null });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<AutoReplies brandId={brandId} />, { locale: "es" });
    expect(await screen.findByRole("alert")).toHaveTextContent(es.Analytics.autoRepliesError);
    await userEvent.click(screen.getByRole("button", { name: es.Analytics.autoRepliesRetry }));
    expect(await screen.findByText(es.Analytics.autoRepliesOff)).toBeInTheDocument();
  });
});
