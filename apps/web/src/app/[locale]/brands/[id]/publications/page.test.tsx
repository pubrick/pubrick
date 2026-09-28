import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import PublicationOperationsPage from "./page";

const brandId = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const postId = "ddc835ad-6cbf-41a1-94d1-134948608aac";
const channelId = "f3b28480-f9d1-4e86-b95a-201ac58582b8";
const adaptationId = "ea2436a0-5bfa-4ad4-83ba-e39244a49258";
const at = "2026-09-28T10:00:00.000Z";

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

beforeEach(() => signedInSession());

describe("publication operations inbox", () => {
  it("shows an unknown delivery as attention and links to its adaptation", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith(`/api/brands/${brandId}`)) return response({ name: "Acme" });
        return response({
          rows: [
            {
              id: adaptationId,
              contentItemId: postId,
              title: "Autumn notes",
              channelId,
              channelName: "Main",
              platform: "telegram",
              deliveryOutcome: "unknown",
              failureReason: "outcome_unknown",
              scheduledAt: null,
              publishedAt: null,
              externalUrl: null,
              assertedAt: null,
              assertedByName: null,
              createdAt: at,
            },
          ],
          nextCursor: null,
        });
      }),
    );
    await renderAsync(<PublicationOperationsPage params={Promise.resolve({ id: brandId })} />);
    const row = await screen.findByRole("link", { name: /Autumn notes/ });
    expect(row).toHaveAttribute("href", `/en/content/${postId}#adaptation-${adaptationId}`);
    expect(within(row).getByText(en.Content.adaptationStatus.unknown)).toBeVisible();
    expect(within(row).getByText(en.PublicationOperations.unknownSafety)).toBeVisible();
    expect(calls.some((url) => url.includes("filter=needs_attention"))).toBe(true);
    expect(screen.queryByRole("button", { name: /retry|publish|cancel/i })).not.toBeInTheDocument();
  });

  it("changes filters and appends a cursor page without duplicating the first", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith(`/api/brands/${brandId}`)) return response({ name: "Acme" });
        const published = url.includes("filter=published");
        const second = url.includes("cursor=next");
        return response({
          rows: published
            ? [
                {
                  id: second ? "2" : "1",
                  contentItemId: postId,
                  title: second ? "Second" : "First",
                  channelId,
                  channelName: "Main",
                  platform: "vk",
                  deliveryOutcome: "published",
                  failureReason: null,
                  scheduledAt: null,
                  publishedAt: at,
                  externalUrl: "https://vk.com/1",
                  assertedAt: null,
                  assertedByName: null,
                  createdAt: at,
                },
              ]
            : [],
          nextCursor: published && !second ? "next" : null,
        });
      }),
    );
    await renderAsync(<PublicationOperationsPage params={Promise.resolve({ id: brandId })} />);
    expect(await screen.findByText(en.PublicationOperations.empty.needs_attention)).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("tab", { name: en.PublicationOperations.filter.published }));
    expect(await screen.findByRole("link", { name: /First/ })).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.PublicationOperations.loadMore }));
    expect(await screen.findByRole("link", { name: /Second/ })).toBeVisible();
    expect(screen.getAllByRole("link", { name: /First/ })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: en.PublicationOperations.loadMore }),
    ).not.toBeInTheDocument();
    expect(requests.some((url) => url.includes("filter=published&cursor=next"))).toBe(true);
  });
});
