import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
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
});
