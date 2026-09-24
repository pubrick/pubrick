import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import es from "../../../../../../messages/es.json";
import BrandAnalyticsPage from "./page";

const BRAND_ID = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const VK_ID = "40a21268-4c10-4ad9-b05d-519c11231322";
const TG_ID = "15e678e4-dbd6-4166-996b-9cf9b0cdbf1d";
const timestamp = "2026-09-23T12:00:00.000Z";

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function refusal(status: number, code: string): Response {
  return {
    ok: false,
    status,
    statusText: "Request refused",
    text: async () => JSON.stringify({ code, message: "Server refusal" }),
  } as Response;
}

function telegramResults() {
  return {
    days: 30,
    publishedCount: 2,
    measuredCount: 0,
    hasMore: false,
    totals: { views: null, likes: null, comments: null, shares: null },
    posts: [
      {
        id: TG_ID,
        contentItemId: TG_ID,
        title: "Telegram story",
        platform: "telegram",
        channelName: "Telegram",
        externalUrl: "https://t.me/example/1",
        publishedAt: timestamp,
        metrics: {
          status: "not_collected",
          stale: false,
          checkedAt: null,
          views: null,
          likes: null,
          comments: null,
          shares: null,
        },
        canRefresh: false,
      },
      {
        id: VK_ID,
        contentItemId: VK_ID,
        title: "VK story",
        platform: "vk",
        channelName: "VK",
        externalUrl: "https://vk.com/wall-123_9",
        publishedAt: timestamp,
        metrics: {
          status: "not_collected",
          stale: false,
          checkedAt: null,
          views: null,
          likes: null,
          comments: null,
          shares: null,
        },
        canRefresh: false,
      },
    ],
  };
}

describe("brand publication results", () => {
  beforeEach(() => {
    signedInSession();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("distinguishes a measured zero from missing Telegram metrics and checks only the VK post", async () => {
    const calls: string[] = [];
    let checked = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/refresh")) {
        checked = true;
        return response({
          status: "available",
          stale: false,
          checkedAt: timestamp,
          views: 0,
          likes: 3,
          comments: null,
          shares: null,
        });
      }
      const metrics = checked
        ? {
            status: "available",
            stale: false,
            checkedAt: timestamp,
            views: 0,
            likes: 3,
            comments: null,
            shares: null,
          }
        : {
            status: "not_collected",
            stale: false,
            checkedAt: null,
            views: null,
            likes: null,
            comments: null,
            shares: null,
          };
      return response({
        days: 30,
        publishedCount: 2,
        measuredCount: checked ? 1 : 0,
        hasMore: false,
        totals: {
          views: checked ? 0 : null,
          likes: checked ? 3 : null,
          comments: null,
          shares: null,
        },
        posts: [
          {
            id: VK_ID,
            contentItemId: VK_ID,
            title: "VK story",
            platform: "vk",
            channelName: "VK",
            externalUrl: "https://vk.com/wall-123_9",
            publishedAt: timestamp,
            metrics,
            canRefresh: !checked,
          },
          {
            id: TG_ID,
            contentItemId: TG_ID,
            title: "Telegram story",
            platform: "telegram",
            channelName: "Telegram",
            externalUrl: null,
            publishedAt: timestamp,
            metrics: {
              status: "not_collected",
              stale: false,
              checkedAt: null,
              views: null,
              likes: null,
              comments: null,
              shares: null,
            },
            canRefresh: false,
          },
        ],
      });
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await waitFor(() => expect(screen.getByText("VK story")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: en.Analytics.viewReplySample })).toHaveLength(1);
    expect(screen.getAllByText(en.Analytics.not_collected)).toHaveLength(2);
    expect(
      screen
        .getAllByText(`${en.Analytics.views}:`)
        .map((element) => element.parentElement?.textContent),
    ).toEqual(["Views: —", "Views: —"]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Analytics.refresh }));
    await waitFor(() => expect(screen.getByText(en.Analytics.available)).toBeInTheDocument());
    expect(
      screen
        .getAllByText(`${en.Analytics.views}:`)
        .map((element) => element.parentElement?.textContent),
    ).toEqual(["Views: 0", "Views: —"]);
    expect(calls.filter((call) => call.startsWith("POST "))).toEqual([
      `POST /api/analytics/brands/${BRAND_ID}/publications/${VK_ID}/refresh`,
    ]);
  });

  it("collects a Telegram reply sample and checks its result without reloading analytics", async () => {
    const calls: string[] = [];
    let reads = 0;
    const requestedAt = new Date().toISOString();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments/refresh")) return response({ queued: true });
      if (url.endsWith("/comments")) {
        reads++;
        return response({
          status: reads === 1 ? "not_collected" : reads === 2 ? "pending" : "available",
          checkedAt: reads >= 3 ? new Date().toISOString() : null,
          requestedAt: reads === 1 ? null : requestedAt,
          canCollect: true,
          errorCode: null,
          comments:
            reads >= 3
              ? [
                  {
                    id: "00000000-0000-4000-8000-000000000001",
                    body: "A useful reader reply.",
                    publishedAt: timestamp,
                    author: "Alice",
                  },
                ]
              : [],
        });
      }
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await screen.findByText("Telegram story");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Analytics.viewReplySample }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText(en.Analytics.replyNotCollected)).toBeInTheDocument();
    expect(dialog.getByText(en.Analytics.replySampleHint)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: en.Analytics.collectReplies }));
    expect(await dialog.findByText(en.Analytics.replyPending)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: en.Analytics.checkReplyResult }));
    expect(await dialog.findByText("A useful reader reply.")).toBeInTheDocument();
    expect(dialog.queryByText("Alice")).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: en.Analytics.collectReplies })).toBeDisabled();
    expect(dialog.getByText(en.Analytics.replyCooldown)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: en.Ui.close }));
    await user.click(screen.getByRole("button", { name: en.Analytics.viewReplySample }));
    const reopened = within(await screen.findByRole("dialog"));
    expect(await reopened.findByText("A useful reader reply.")).toBeInTheDocument();
    expect(reopened.getByRole("button", { name: en.Analytics.collectReplies })).toBeDisabled();
    expect(calls.filter((call) => call.startsWith("POST "))).toEqual([
      `POST /api/analytics/brands/${BRAND_ID}/publications/${TG_ID}/comments/refresh`,
    ]);
    expect(calls.filter((call) => call.includes(`/publications/${TG_ID}/comments`))).toHaveLength(
      5,
    );
    expect(
      calls.filter((call) => call === `GET /api/analytics/brands/${BRAND_ID}?days=30`),
    ).toHaveLength(1);
  });

  it.each([
    ["no_comments", "replyNoComments"],
    ["unavailable", "replyUnavailable"],
    ["error", "replyError"],
  ] as const)("explains a Telegram reply %s result", async (status, messageKey) => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments"))
        return response({
          status,
          checkedAt: new Date().toISOString(),
          requestedAt: new Date().toISOString(),
          canCollect: true,
          errorCode: null,
          comments: [],
        });
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await screen.findByText("Telegram story");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Analytics.viewReplySample }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText(en.Analytics[messageKey])).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: en.Analytics.collectReplies })).toBeDisabled();
  });

  it("does not offer collection for an unsupported Telegram publication link", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments"))
        return response({
          status: "unavailable",
          checkedAt: null,
          requestedAt: null,
          canCollect: false,
          errorCode: "unsupported_link",
          comments: [],
        });
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await screen.findByText("Telegram story");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Analytics.viewReplySample }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText(en.Analytics.replyUnsupported)).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: en.Analytics.collectReplies })).toBeNull();
  });

  it("offers a new collection after the server reports an aged pending check as an error", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments"))
        return response({
          status: "error",
          checkedAt: null,
          requestedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
          canCollect: true,
          errorCode: "pending_expired",
          comments: [],
        });
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await screen.findByText("Telegram story");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Analytics.viewReplySample }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText(en.Analytics.replyError)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: en.Analytics.collectReplies })).toBeEnabled();
  });

  it.each([
    ["telegram_not_connected", "replyTelegramNotConnected"],
    ["telegram_not_configured", "replyTelegramNotConfigured"],
  ] as const)("explains the %s setup failure", async (errorCode, messageKey) => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments"))
        return response({
          status: "error",
          checkedAt: null,
          requestedAt: new Date().toISOString(),
          canCollect: true,
          errorCode,
          comments: [],
        });
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await screen.findByText("Telegram story");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Analytics.viewReplySample }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText(en.Analytics[messageKey])).toBeInTheDocument();
    expect(dialog.queryByText(en.Analytics.replyError)).toBeNull();
  });

  it("keeps a queued check visible when rereading its result fails", async () => {
    let reads = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments/refresh")) return response({ queued: true });
      if (url.endsWith("/comments")) {
        reads++;
        return reads === 1
          ? response({
              status: "not_collected",
              checkedAt: null,
              requestedAt: null,
              canCollect: true,
              errorCode: null,
              comments: [],
            })
          : refusal(500, "internal_error");
      }
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await screen.findByText("Telegram story");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Analytics.viewReplySample }));
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByText(en.Analytics.replyNotCollected);
    await user.click(dialog.getByRole("button", { name: en.Analytics.collectReplies }));
    expect(await dialog.findByText(en.Analytics.replyPending)).toBeInTheDocument();
    expect(await dialog.findByRole("alert")).toHaveTextContent(en.Analytics.replyLoadError);
    expect(dialog.getByRole("button", { name: en.Analytics.checkReplyResult })).toBeEnabled();
  });

  it("redirects a signed-in user with no active organization when the reply read is refused", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments"))
        return {
          ok: false,
          status: 403,
          statusText: "Forbidden",
          text: async () =>
            JSON.stringify({ code: "no_active_organization", message: "No organization" }),
        } as Response;
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await screen.findByText("Telegram story");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.Analytics.viewReplySample }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/en/onboarding"));
  });

  it("localizes a refused reply read in Spanish", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments")) return refusal(403, "forbidden");
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />, {
      locale: "es",
    });
    await screen.findByText("Telegram story");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: es.Analytics.viewReplySample }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByRole("alert")).toHaveTextContent(es.Errors.forbidden);
    expect(dialog.getByRole("button", { name: es.Analytics.retry })).toBeInTheDocument();
  });

  it("localizes the reply collection cooldown refusal in Spanish", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response({ id: BRAND_ID, name: "Acme" });
      if (url.endsWith("/comments/refresh"))
        return refusal(409, "publication_comments_refresh_cooldown");
      if (url.endsWith("/comments"))
        return response({
          status: "not_collected",
          requestedAt: null,
          checkedAt: null,
          canCollect: true,
          errorCode: null,
          comments: [],
        });
      return response(telegramResults());
    });
    await renderAsync(<BrandAnalyticsPage params={Promise.resolve({ id: BRAND_ID })} />, {
      locale: "es",
    });
    await screen.findByText("Telegram story");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: es.Analytics.viewReplySample }));
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByText(es.Analytics.replyNotCollected);
    await user.click(dialog.getByRole("button", { name: es.Analytics.collectReplies }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      es.Errors.publication_comments_refresh_cooldown,
    );
  });
});
