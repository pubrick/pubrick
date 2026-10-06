import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import PublicationOperationsPage from "./page";

const calendarTranslate = vi.hoisted(
  () => (key: string) => (key === "queue" ? "Queue" : "Calendar"),
);
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useTranslations: (namespace?: string) => {
      const translate = actual.useTranslations(
        namespace === "PublicationCalendar" ? undefined : namespace,
      );
      return namespace === "PublicationCalendar" ? calendarTranslate : translate;
    },
  };
});
vi.mock("./publication-calendar", () => ({
  PublicationCalendar: ({ brandId }: { brandId: string }) => (
    <section aria-label="Calendar view">{brandId}</section>
  ),
}));

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
  it("preserves the scheduled queue by default and opens a separate calendar view", async () => {
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init?: RequestInit) => {
        const url = String(input);
        if (init?.method && init.method !== "GET") writes.push(url);
        if (url.endsWith(`/api/brands/${brandId}`)) return response({ name: "Acme" });
        return response({ rows: [], nextCursor: null });
      }),
    );
    await renderAsync(<PublicationOperationsPage params={Promise.resolve({ id: brandId })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: en.PublicationOperations.filter.scheduled }));
    expect(screen.getByRole("tab", { name: "Queue" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(en.PublicationOperations.empty.scheduled)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Calendar view" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Calendar" }));
    expect(screen.getByRole("region", { name: "Calendar view" })).toHaveTextContent(brandId);
    expect(screen.queryByText(en.PublicationOperations.empty.scheduled)).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: en.PublicationOperations.filter.published }));
    expect(await screen.findByText(en.PublicationOperations.empty.published)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Calendar view" })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });
  it("shows an unknown delivery as attention and links to its adaptation", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith(`/api/brands/${brandId}`)) return response({ name: "Acme" });
        if (url.includes("/publications/archive")) return response({ rows: [], nextCursor: null });
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
        if (url.includes("/publications/archive")) return response({ rows: [], nextCursor: null });
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

  it("shows paged deleted-channel receipts without dead action links or unsafe external links", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith(`/api/brands/${brandId}`)) return response({ name: "Acme" });
        if (url.includes("/publications/archive")) {
          const second = url.includes("cursor=next");
          return response({
            rows: [
              {
                id: second ? "1ec2fa88-a1aa-4a81-a79b-d340659984ba" : adaptationId,
                channelName: "Old feed",
                channelPlatform: "telegram",
                status: second ? "in_flight" : "published",
                externalUrl: second ? "javascript:alert(1)" : "https://t.me/old/1",
                assertedAt: null,
                createdAt: at,
              },
            ],
            nextCursor: second ? null : "next",
          });
        }
        return response({ rows: [], nextCursor: null });
      }),
    );
    await renderAsync(<PublicationOperationsPage params={Promise.resolve({ id: brandId })} />);
    expect(
      await screen.findByRole("heading", { name: en.PublicationOperations.archiveTitle }),
    ).toBeVisible();
    const external = await screen.findByRole("link", {
      name: en.PublicationOperations.archiveOpenPublication,
    });
    expect(external).toHaveAttribute("href", "https://t.me/old/1");
    expect(screen.queryByRole("link", { name: /Old feed/ })).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.PublicationOperations.loadMore }));
    expect(await screen.findByText(en.PublicationOperations.archiveStatus.in_flight)).toBeVisible();
    expect(screen.getByText("javascript:alert(1)")).toBeVisible();
    expect(screen.queryByRole("link", { name: "javascript:alert(1)" })).not.toBeInTheDocument();
    expect(requests.some((url) => url.includes("/publications/archive?cursor=next"))).toBe(true);
    expect(screen.queryByRole("link", { name: /Old feed/ })).not.toBeInTheDocument();
  });
});
