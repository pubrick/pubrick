import {
  newsItemListQuerySchema,
  newsRerankRequestSchema,
  newsSourceCreateSchema,
  privateTelegramSourceCreateSchema,
  runCreateSchema,
} from "@pubrick/shared";
import { act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { navigationState, routerMock } from "@/test/next-navigation.stub";
import { renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import SourcesPage from "./page";

const BRAND_ID = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const OTHER_BRAND_ID = "255e6b41-cf47-4e69-8a5a-af06827d82e8";
const CHANNEL_ID = "15e678e4-dbd6-4166-996b-9cf9b0cdbf1d";
const SOURCE_ID = "d8787c8f-4308-4bc9-8896-6d9e272a0be8";
const ITEM_ID = "40a21268-4c10-4ad9-b05d-519c11231322";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("watched sources page", () => {
  beforeEach(() => {
    signedInSession();
    vi.stubGlobal("fetch", vi.fn());
    window.history.replaceState({}, "", `/en/brands/${BRAND_ID}/sources`);
  });

  afterEach(() => window.history.replaceState({}, "", "/"));

  function install(
    items: unknown[] = [],
    sources: unknown[] = [],
    analysis?: unknown,
    rerankResults: unknown[] = [],
  ) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let autoEnabled = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/sources/items/rerank?"))
        return response(
          200,
          rerankResults.shift() ?? { processed: 0, changed: 0, nextCursor: null },
        );
      if (url.includes("/api/sources/items?")) return response(200, items);
      if (url.includes("/comment-analysis?"))
        return response(
          method === "POST" ? 201 : 200,
          method === "POST"
            ? {
                status: "ready",
                sampleSize: 1,
                analyzedAt: "2026-09-23T12:00:00.000Z",
                result: {
                  summary: "Readers ask about pricing.",
                  sentiment: { positive: 0, neutral: 1, negative: 0 },
                  themes: [{ label: "Pricing", mentions: 1 }],
                  feedback: ["Clarify the pricing."],
                },
              }
            : (analysis ?? { status: "unavailable" }),
        );
      if (url.includes("/comments/refresh")) return response(201, { queued: true });
      if (url.includes("/comments?")) return response(200, []);
      if (url.endsWith("/api/sources/telegram-connection"))
        return response(200, { connected: false });
      if (url.includes("/api/sources/comment-collection?")) {
        if (method === "PUT") autoEnabled = (body as { enabled: boolean }).enabled;
        return response(200, {
          enabled: autoEnabled,
          updatedAt: autoEnabled ? new Date().toISOString() : null,
        });
      }
      if (url.includes("/api/sources?")) return response(200, sources);
      if (url.includes("/api/channels?"))
        return response(200, [{ id: CHANNEL_ID, name: "Updates", platform: "telegram" }]);
      if (url.endsWith("/api/runs"))
        return response(201, { id: "c8c29afd-6316-4e39-a7f1-3399d7063b80" });
      return response(201, {});
    });
    return calls;
  }

  it("confirms opt-in, explains free sampling limits, and keeps one primary action", async () => {
    const calls = install();
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const enable = await screen.findByRole("button", { name: en.Sources.autoCommentsEnable });
    expect(screen.getByText(en.Sources.autoCommentsLimits)).toBeInTheDocument();
    expect(screen.getByText(en.Sources.autoCommentsDescription)).toBeInTheDocument();
    await userEvent.click(enable);
    const dialog = screen.getByRole("dialog", { name: en.Sources.autoCommentsConfirmTitle });
    expect(
      calls.filter((call) => call.url.includes("comment-collection") && call.method === "PUT"),
    ).toHaveLength(0);
    await userEvent.click(
      within(dialog).getByRole("button", { name: en.Sources.autoCommentsEnable }),
    );
    expect(await screen.findByText(en.Sources.autoCommentsEnabled)).toBeInTheDocument();
    expect(
      calls
        .filter((call) => call.url.includes("comment-collection") && call.method === "PUT")
        .map((call) => call.body),
    ).toEqual([{ enabled: true }]);
    expect(screen.getByRole("button", { name: en.Sources.add })).toBeInTheDocument();
  });

  it("shows the model score separately from an editor-adjusted ranking", async () => {
    install([
      {
        id: ITEM_ID,
        brandId: BRAND_ID,
        sourceId: SOURCE_ID,
        title: "Battery rules",
        summary: "Recycling guidance",
        url: "https://example.com/batteries",
        publishedAt: null,
        createdAt: "2026-09-23T12:00:00.000Z",
        relevanceStatus: "scored",
        relevanceScore: 0.7,
        rankScore: 0.82,
        feedbackDelta: 0.12,
        relevanceReason: "Relevant to manufacturers.",
        relevanceUrgency: "timely",
        relevanceErrorCode: null,
        relevanceScoredAt: "2026-09-23T12:00:00.000Z",
        editorSignal: null,
      },
    ]);
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    expect(await screen.findByText(en.Sources.aiScore.replace("{score}", "70"))).toBeVisible();
    expect(screen.getByText(en.Sources.rankScore.replace("{score}", "82"))).toBeVisible();
  });

  it("updates saved-feedback rankings in bounded pages without requesting AI scoring", async () => {
    const cursor = { createdAt: "2026-09-23T12:00:00.000Z", id: ITEM_ID };
    const calls = install([], [], undefined, [
      { processed: 50, changed: 3, nextCursor: cursor },
      { processed: 4, changed: 1, nextCursor: null },
    ]);
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    expect(screen.getByText(en.Sources.rerankHint)).toBeVisible();
    await user.click(screen.getByRole("button", { name: en.Sources.rerank }));
    expect(await screen.findByRole("button", { name: en.Sources.rerankContinue })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("50");
    await user.click(screen.getByRole("button", { name: en.Sources.rerankContinue }));
    expect(await screen.findByRole("button", { name: en.Sources.rerank })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("4");
    const requests = calls.filter((call) => call.url.includes("/api/sources/items/rerank?"));
    expect(requests).toEqual([
      { url: expect.stringContaining(`brandId=${BRAND_ID}`), method: "POST", body: { days: 30 } },
      {
        url: expect.stringContaining(`brandId=${BRAND_ID}`),
        method: "POST",
        body: { days: 30, cursor },
      },
    ]);
    for (const request of requests) {
      expect(newsRerankRequestSchema.parse(request.body)).toEqual(request.body);
    }
    expect(
      calls.some((call) => call.url.includes("/score?") || call.url.includes("/api/usage")),
    ).toBe(false);
  });

  it("adds a brand-scoped feed from the header form", async () => {
    const calls = install();
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Sources.name), "Journal");
    await user.type(screen.getByLabelText(en.Sources.url), "https://example.com/feed.xml");
    await user.click(screen.getByRole("button", { name: en.Sources.add }));
    await waitFor(() =>
      expect(
        calls.some((call) => call.method === "POST" && call.url.endsWith("/api/sources")),
      ).toBe(true),
    );
    const request = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/sources"),
    );
    expect(request?.body).toEqual({
      brandId: BRAND_ID,
      name: "Journal",
      kind: "rss",
      url: "https://example.com/feed.xml",
      checkIntervalMinutes: 60,
    });
    expect(newsSourceCreateSchema.parse(request?.body)).toEqual(request?.body);
  });

  it("shows setup guidance and sends a public Telegram channel as its own source type", async () => {
    const calls = install();
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Sources.kind), "telegram");
    expect(screen.getByRole("link", { name: en.Sources.setupGuide })).toHaveAttribute(
      "href",
      "https://github.com/pubrick/pubrick/blob/main/docs/telegram-sources.md",
    );
    await user.type(screen.getByLabelText(en.Sources.name), "Competitor");
    await user.type(screen.getByLabelText(en.Sources.telegramUrl), "https://t.me/example_channel");
    await user.click(screen.getByRole("button", { name: en.Sources.add }));
    const request = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/sources"),
    );
    expect(request?.body).toEqual({
      brandId: BRAND_ID,
      name: "Competitor",
      kind: "telegram",
      url: "https://t.me/example_channel",
      checkIntervalMinutes: 60,
    });
    expect(newsSourceCreateSchema.parse(request?.body)).toEqual(request?.body);
  });

  it("explains an invalid Telegram URL without sending it to the API", async () => {
    const calls = install();
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Sources.kind), "telegram");
    await user.type(screen.getByLabelText(en.Sources.name), "Private invite");
    await user.type(screen.getByLabelText(en.Sources.telegramUrl), "https://t.me/+privateinvite");
    await user.click(screen.getByRole("button", { name: en.Sources.add }));
    expect(screen.getByRole("alert")).toHaveTextContent(en.Sources.invalidTelegramUrl);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/api/sources"))).toBe(
      false,
    );
  });

  it("edits a feed in place without deleting its collected stories", async () => {
    const calls = install(
      [],
      [
        {
          id: SOURCE_ID,
          brandId: BRAND_ID,
          name: "Journal",
          kind: "rss",
          url: "https://example.com/old.xml",
          isActive: true,
        },
      ],
    );
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Sources.edit }));
    const dialog = screen.getByRole("dialog", { name: en.Sources.editTitle });
    await user.clear(within(dialog).getByLabelText(en.Sources.name));
    await user.type(within(dialog).getByLabelText(en.Sources.name), "New journal");
    await user.clear(within(dialog).getByLabelText(en.Sources.url));
    await user.type(within(dialog).getByLabelText(en.Sources.url), "https://example.com/new.xml");
    await user.click(within(dialog).getByRole("button", { name: en.Sources.save }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "PATCH" && call.url.includes(SOURCE_ID))).toBe(
        true,
      ),
    );
    expect(calls.find((call) => call.method === "PATCH" && call.url.includes(SOURCE_ID))).toEqual({
      url: `/api/sources/${SOURCE_ID}?brandId=${BRAND_ID}`,
      method: "PATCH",
      body: { name: "New journal", url: "https://example.com/new.xml" },
    });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: en.Sources.editTitle })).not.toBeInTheDocument(),
    );
  });

  it("sends only the changed feed name, preserving a newer URL from another editor", async () => {
    const calls = install(
      [],
      [
        {
          id: SOURCE_ID,
          brandId: BRAND_ID,
          name: "Journal",
          kind: "rss",
          url: "https://example.com/old.xml",
          isActive: true,
        },
      ],
    );
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Sources.edit }));
    const dialog = screen.getByRole("dialog", { name: en.Sources.editTitle });
    await user.clear(within(dialog).getByLabelText(en.Sources.name));
    await user.type(within(dialog).getByLabelText(en.Sources.name), "Updated journal");
    await user.click(within(dialog).getByRole("button", { name: en.Sources.save }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      name: "Updated journal",
    });
  });

  it("rejects an invalid edited feed URL before the API and cancels without a write", async () => {
    const calls = install(
      [],
      [
        {
          id: SOURCE_ID,
          brandId: BRAND_ID,
          name: "Journal",
          kind: "rss",
          url: "https://example.com/old.xml",
          isActive: true,
        },
      ],
    );
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Sources.edit }));
    const dialog = screen.getByRole("dialog", { name: en.Sources.editTitle });
    await user.clear(within(dialog).getByLabelText(en.Sources.url));
    await user.type(within(dialog).getByLabelText(en.Sources.url), "javascript:bad");
    await user.click(within(dialog).getByRole("button", { name: en.Sources.save }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(en.Sources.invalidFeedUrl);
    await user.click(within(dialog).getByRole("button", { name: en.Sources.cancel }));
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("edits a private Telegram source name without exposing its identity as an input", async () => {
    const calls = install(
      [],
      [
        {
          id: SOURCE_ID,
          brandId: BRAND_ID,
          name: "Internal",
          kind: "telegram_private",
          url: "https://t.me/c/123456",
          isActive: true,
        },
      ],
    );
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Sources.edit }));
    const dialog = screen.getByRole("dialog", { name: en.Sources.editTitle });
    expect(within(dialog).getByText(en.Sources.privateIdentityFixed)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(en.Sources.url)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(en.Sources.telegramUrl)).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(en.Sources.name));
    await user.type(within(dialog).getByLabelText(en.Sources.name), "Staff");
    await user.click(within(dialog).getByRole("button", { name: en.Sources.save }));
    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ name: "Staff" });
  });

  it("closes a source edit when navigating to another brand in the same page instance", async () => {
    const calls = install(
      [],
      [
        {
          id: SOURCE_ID,
          brandId: BRAND_ID,
          name: "Journal",
          kind: "rss",
          url: "https://example.com/feed.xml",
          isActive: true,
        },
      ],
    );
    const view = await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    await userEvent.click(screen.getByRole("button", { name: en.Sources.edit }));
    expect(screen.getByRole("dialog", { name: en.Sources.editTitle })).toBeInTheDocument();
    await act(async () => {
      view.rerender(<SourcesPage params={Promise.resolve({ id: OTHER_BRAND_ID })} />);
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: en.Sources.editTitle })).not.toBeInTheDocument(),
    );
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("does not show an old brand save after navigating away during the request", async () => {
    install(
      [],
      [
        {
          id: SOURCE_ID,
          brandId: BRAND_ID,
          name: "Journal",
          kind: "rss",
          url: "https://example.com/feed.xml",
          isActive: true,
        },
      ],
    );
    const fallbackFetch = vi.mocked(fetch).getMockImplementation();
    let resolvePatch: ((result: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (init?.method === "PATCH" && String(input).includes(`/api/sources/${SOURCE_ID}`)) {
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve;
        });
      }
      if (!fallbackFetch) throw new Error("Fetch fixture missing");
      return fallbackFetch(input, init);
    });
    const view = await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Sources.edit }));
    const dialog = screen.getByRole("dialog", { name: en.Sources.editTitle });
    await user.clear(within(dialog).getByLabelText(en.Sources.name));
    await user.type(within(dialog).getByLabelText(en.Sources.name), "Updated journal");
    await user.click(within(dialog).getByRole("button", { name: en.Sources.save }));
    await waitFor(() => expect(resolvePatch).toBeDefined());
    await act(async () => {
      view.rerender(<SourcesPage params={Promise.resolve({ id: OTHER_BRAND_ID })} />);
    });
    await act(async () => resolvePatch?.(response(200, {})));
    expect(screen.queryByRole("dialog", { name: en.Sources.editTitle })).not.toBeInTheDocument();
    expect(screen.queryByText(en.Sources.saved)).not.toBeInTheDocument();
  });

  it("sends a private invite only in the protected request body and clears the field", async () => {
    const calls = install();
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Sources.kind), "telegram_private");
    await user.type(screen.getByLabelText(en.Sources.name), "Joined channel");
    const input = screen.getByLabelText(en.Sources.privateInvite);
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "https://t.me/+SecretInvite123");
    await user.click(screen.getByRole("button", { name: en.Sources.add }));
    const sent = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/api/sources/telegram-private"),
    );
    expect(sent?.body).toEqual({
      brandId: BRAND_ID,
      name: "Joined channel",
      invite: "https://t.me/+SecretInvite123",
    });
    expect(privateTelegramSourceCreateSchema.parse(sent?.body)).toEqual(sent?.body);
    expect(sent?.url).not.toContain("SecretInvite123");
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("labels a private channel with its safe link and does not offer public comment collection", async () => {
    install(
      [
        {
          id: ITEM_ID,
          brandId: BRAND_ID,
          sourceId: SOURCE_ID,
          title: "Member story",
          summary: "A private story summary.",
          url: "https://t.me/c/123456/1",
          publishedAt: null,
          createdAt: "2026-09-23T12:00:00.000Z",
          relevanceStatus: "unscored",
          relevanceScore: null,
          relevanceReason: null,
          relevanceUrgency: null,
          relevanceErrorCode: null,
          relevanceScoredAt: null,
        },
      ],
      [
        {
          id: SOURCE_ID,
          brandId: BRAND_ID,
          kind: "telegram_private",
          name: "Joined channel",
          url: "https://t.me/c/123456",
          isActive: true,
          lastErrorCode: null,
          lastCheckedAt: null,
        },
      ],
    );
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    expect((await screen.findAllByText("Joined channel")).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain(en.Sources.telegramPrivate);
    expect(document.body.textContent).toContain("https://t.me/c/123456");
    expect(screen.queryByRole("button", { name: en.Sources.comments })).not.toBeInTheDocument();
  });

  it("starts a source run with the article summary, URL, and explicitly chosen channel", async () => {
    const item = {
      id: ITEM_ID,
      brandId: BRAND_ID,
      sourceId: SOURCE_ID,
      title: "New market hall",
      summary: "The council approved the project.",
      url: "https://example.com/articles/hall",
      publishedAt: null,
      createdAt: "2026-09-23T12:00:00.000Z",
    };
    const calls = install([item]);
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    expect(calls.map((call) => call.url)).toContainEqual(
      expect.stringContaining("/api/sources/items?"),
    );
    await waitFor(() => expect(document.body.textContent).toContain(item.title));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Sources.createDraft }));
    const dialog = within(screen.getByRole("dialog", { name: en.Sources.draftTitle }));
    expect(dialog.getByRole("button", { name: en.Sources.generate })).toBeDisabled();
    await user.click(dialog.getByRole("checkbox", { name: /Updates/ }));
    await user.click(dialog.getByRole("button", { name: en.Sources.generate }));
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(expect.stringContaining("/content/runs/")),
    );
    const request = calls.find((call) => call.method === "POST" && call.url.endsWith("/api/runs"));
    const payload = request?.body;
    expect(payload).toEqual({
      brandId: BRAND_ID,
      channelIds: [CHANNEL_ID],
      material: "New market hall\n\nThe council approved the project.",
      sourceUrl: item.url,
    });
    expect(runCreateSchema.parse(payload)).toEqual(payload);
  });

  it("saves an article as a topic and records an editor signal", async () => {
    const item = {
      id: ITEM_ID,
      brandId: BRAND_ID,
      sourceId: SOURCE_ID,
      title: "New market hall",
      summary: "The council approved the project.",
      url: "https://example.com/articles/hall",
      editorSignal: null,
      publishedAt: null,
      createdAt: "2026-09-23T12:00:00.000Z",
    };
    const calls = install([item], [], undefined, [
      { processed: 50, changed: 2, nextCursor: { createdAt: item.createdAt, id: ITEM_ID } },
    ]);
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    await waitFor(() => expect(document.body.textContent).toContain(item.title));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Sources.rerank }));
    expect(await screen.findByRole("button", { name: en.Sources.rerankContinue })).toBeVisible();
    await user.click(screen.getByRole("button", { name: en.Sources.more }));
    await user.click(screen.getByRole("menuitem", { name: en.Sources.saveTopic }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === "POST" && call.url.includes(`/api/topics/from-news/${ITEM_ID}`),
        ),
      ).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: en.Sources.more }));
    await user.click(screen.getByRole("menuitem", { name: en.Sources.relevant }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: expect.stringContaining(`/api/topics/news/${ITEM_ID}/feedback?brandId=${BRAND_ID}`),
        method: "PATCH",
        body: { signal: "relevant" },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(en.Sources.feedbackSaved);
    expect(screen.getByRole("button", { name: en.Sources.rerank })).toBeVisible();
  });

  it("requests ranked articles and queues an unscored item without changing editor feedback", async () => {
    const calls = install([
      {
        id: ITEM_ID,
        brandId: BRAND_ID,
        sourceId: SOURCE_ID,
        title: "New market hall",
        summary: "The council approved the project.",
        url: "https://example.com/articles/hall",
        editorSignal: "irrelevant",
        publishedAt: null,
        createdAt: "2026-09-23T12:00:00.000Z",
        relevanceStatus: "unscored",
        relevanceScore: null,
        relevanceReason: null,
        relevanceUrgency: null,
        relevanceErrorCode: null,
        relevanceScoredAt: null,
      },
    ]);
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    await waitFor(() => expect(document.body.textContent).toContain(en.Sources.statusUnscored));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Sources.sortLabel), "relevance");
    await user.selectOptions(screen.getByLabelText(en.Sources.statusLabel), "unscored");
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("sort=relevance&status=unscored"))).toBe(true),
    );
    const request = calls.find((call) => call.url.includes("sort=relevance&status=unscored"));
    const query = Object.fromEntries(new URL(request?.url ?? "", "http://localhost").searchParams);
    expect(query).toEqual({ brandId: BRAND_ID, sort: "relevance", status: "unscored" });
    expect(newsItemListQuerySchema.parse(query)).toEqual(query);
    await user.click(screen.getByRole("button", { name: en.Sources.more }));
    await user.click(screen.getByRole("menuitem", { name: en.Sources.score }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: expect.stringContaining(`/api/sources/items/${ITEM_ID}/score?brandId=${BRAND_ID}`),
        method: "POST",
        body: null,
      }),
    );
    expect(document.body.textContent).toContain(en.Sources.irrelevant);
  });

  it("debounces title search, filters by source, and clears all news filters", async () => {
    const calls = install([], [{ id: SOURCE_ID, name: "Journal", kind: "rss", isActive: true }]);
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Sources.sourceFilterLabel), SOURCE_ID);
    await user.selectOptions(screen.getByLabelText(en.Sources.minScoreLabel), "75");
    await user.type(screen.getByLabelText(en.Sources.searchLabel), "Сводка 100%_");
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.includes(`/api/sources/items?`) &&
            new URL(call.url, "http://localhost").searchParams.get("search") === "Сводка 100%_",
        ),
      ).toBe(true),
    );
    const matching = calls.find(
      (call) => new URL(call.url, "http://localhost").searchParams.get("search") === "Сводка 100%_",
    );
    expect(
      Object.fromEntries(new URL(matching?.url ?? "", "http://localhost").searchParams),
    ).toEqual({
      brandId: BRAND_ID,
      sort: "recent",
      status: "all",
      minScorePercent: "75",
      sourceId: SOURCE_ID,
      search: "Сводка 100%_",
    });
    expect(screen.getByText(en.Sources.emptyFiltered)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.Sources.showAll }));
    expect(screen.getByLabelText(en.Sources.searchLabel)).toHaveValue("");
    expect(screen.getByLabelText(en.Sources.sourceFilterLabel)).toHaveValue("");
    expect(screen.getByLabelText(en.Sources.minScoreLabel)).toHaveValue("");
    expect(new URLSearchParams(window.location.search).has("news_relevance")).toBe(false);
    await waitFor(() => expect(screen.getByText(en.Sources.emptyNews)).toBeInTheDocument());
  });

  it("shows all stories by default and treats a zero threshold as scored only", async () => {
    const calls = install();
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const threshold = screen.getByLabelText(en.Sources.minScoreLabel);
    expect(threshold).toHaveValue("");
    expect(screen.getByRole("option", { name: en.Sources.minScoreZero })).toHaveValue("0");
    expect(screen.getByText(en.Sources.minScoreHint)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(threshold, "0");
    expect(new URLSearchParams(window.location.search).get("news_relevance")).toBe("0");
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.includes("/api/sources/items?") &&
            new URL(call.url, "http://localhost").searchParams.get("minScorePercent") === "0",
        ),
      ).toBe(true),
    );
    const filtered = calls.find(
      (call) => new URL(call.url, "http://localhost").searchParams.get("minScorePercent") === "0",
    );
    expect(
      newsItemListQuerySchema.parse(
        Object.fromEntries(new URL(filtered?.url ?? "", "http://localhost").searchParams),
      ).minScorePercent,
    ).toBe(0);
    expect(screen.getByText(en.Sources.emptyFiltered)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.Sources.clearMinScore }));
    expect(threshold).toHaveValue("");
    expect(new URLSearchParams(window.location.search).has("news_relevance")).toBe(false);
    await waitFor(() => expect(screen.getByText(en.Sources.emptyNews)).toBeInTheDocument());
  });

  it("restores the AI threshold after remount and browser back navigation", async () => {
    window.history.replaceState({}, "", `?view=compact&news_relevance=40`);
    navigationState.searchParams = new URLSearchParams(window.location.search);
    const calls = install();
    const first = await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const threshold = screen.getByLabelText(en.Sources.minScoreLabel);
    expect(threshold).toHaveValue("40");
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("minScorePercent=40"))).toBe(true),
    );

    const user = userEvent.setup();
    await user.selectOptions(threshold, "75");
    expect(window.location.search).toBe("?view=compact&news_relevance=75");
    first.unmount();

    navigationState.searchParams = new URLSearchParams(window.location.search);
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    expect(screen.getByLabelText(en.Sources.minScoreLabel)).toHaveValue("75");
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("minScorePercent=75"))).toBe(true),
    );

    window.history.replaceState({}, "", `?view=compact&news_relevance=40`);
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getByLabelText(en.Sources.minScoreLabel)).toHaveValue("40");
    expect(new URLSearchParams(window.location.search).get("view")).toBe("compact");
  });

  it("hides stories from the previous threshold while back navigation reloads", async () => {
    window.history.replaceState({}, "", "?news_relevance=75");
    navigationState.searchParams = new URLSearchParams(window.location.search);
    const oldItem = {
      id: ITEM_ID,
      brandId: BRAND_ID,
      sourceId: SOURCE_ID,
      title: "Previously filtered story",
      summary: "Earlier result",
      url: "https://example.com/previous",
      publishedAt: null,
      createdAt: "2026-09-23T12:00:00.000Z",
    };
    const newItem = {
      ...oldItem,
      id: "12912ad4-8693-42f6-8286-80f7b9004ac5",
      title: "Restored threshold story",
      url: "https://example.com/restored",
    };
    install([oldItem]);
    const fallbackFetch = vi.mocked(fetch).getMockImplementation();
    let resolveNewItems: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (
        url.includes("/api/sources/items?") &&
        new URL(url, "http://localhost").searchParams.get("minScorePercent") === "40"
      ) {
        return new Promise<Response>((resolve) => {
          resolveNewItems = resolve;
        });
      }
      if (!fallbackFetch) throw new Error("Fetch fixture missing");
      return fallbackFetch(input, init);
    });

    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    expect(await screen.findByText(oldItem.title)).toBeVisible();

    window.history.replaceState({}, "", "?news_relevance=40");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getByLabelText(en.Sources.minScoreLabel)).toHaveValue("40");
    expect(screen.queryByText(oldItem.title)).not.toBeInTheDocument();
    await waitFor(() => expect(resolveNewItems).toBeDefined());
    expect(screen.queryByText(newItem.title)).not.toBeInTheDocument();

    await act(async () => resolveNewItems?.(response(200, [newItem])));
    expect(await screen.findByText(newItem.title)).toBeVisible();
  });

  it("clears a selected source after that source is removed", async () => {
    const source = { id: SOURCE_ID, name: "Journal", kind: "rss", isActive: true };
    const calls = install([], [source]);
    const fallbackFetch = vi.mocked(fetch).getMockImplementation();
    let removed = false;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === "DELETE" && url.includes(`/api/sources/${SOURCE_ID}`)) {
        removed = true;
        return Promise.resolve(response(200, {}));
      }
      if (url.includes("/api/sources?") && removed) return Promise.resolve(response(200, []));
      if (!fallbackFetch) throw new Error("Fetch fixture missing");
      return fallbackFetch(input, init);
    });
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Sources.sourceFilterLabel), SOURCE_ID);
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes(`sourceId=${SOURCE_ID}`))).toBe(true),
    );
    const itemRequestsBeforeRemoval = calls.filter((call) =>
      call.url.includes("/api/sources/items?"),
    ).length;
    await user.click(screen.getByRole("button", { name: en.Sources.remove }));
    await user.click(
      within(screen.getByRole("dialog", { name: en.Sources.removeTitle })).getByRole("button", {
        name: en.Sources.remove,
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(en.Sources.sourceFilterLabel)).toHaveValue(""),
    );
    await waitFor(() =>
      expect(
        calls
          .filter((call) => call.url.includes("/api/sources/items?"))
          .slice(itemRequestsBeforeRemoval)
          .some(
            (call) =>
              call.url.includes(`/api/sources/items?`) &&
              !new URL(call.url, "http://localhost").searchParams.has("sourceId"),
          ),
      ).toBe(true),
    );
  });

  it("resets news filters when the same page instance opens another brand", async () => {
    const calls = install([], [{ id: SOURCE_ID, name: "Journal", kind: "rss", isActive: true }]);
    const fallbackFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes(`/api/brands/${OTHER_BRAND_ID}`)) {
        return Promise.resolve(response(200, { id: OTHER_BRAND_ID, name: "Other" }));
      }
      if (url.includes(`/api/sources?brandId=${OTHER_BRAND_ID}`)) {
        return Promise.resolve(response(200, []));
      }
      if (!fallbackFetch) throw new Error("Fetch fixture missing");
      return fallbackFetch(input, init);
    });
    const view = await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Sources.sourceFilterLabel), SOURCE_ID);
    await user.selectOptions(screen.getByLabelText(en.Sources.minScoreLabel), "75");
    await user.type(screen.getByLabelText(en.Sources.searchLabel), "first");
    await waitFor(() => expect(calls.some((call) => call.url.includes("search=first"))).toBe(true));
    window.history.replaceState({}, "", `/en/brands/${OTHER_BRAND_ID}/sources`);
    await act(async () => {
      view.rerender(<SourcesPage params={Promise.resolve({ id: OTHER_BRAND_ID })} />);
    });
    await waitFor(() => {
      expect(screen.getByLabelText(en.Sources.sourceFilterLabel)).toHaveValue("");
      expect(screen.getByLabelText(en.Sources.searchLabel)).toHaveValue("");
      expect(screen.getByLabelText(en.Sources.minScoreLabel)).toHaveValue("");
    });
    await waitFor(() =>
      expect(
        calls.some((call) => {
          if (!call.url.includes("/api/sources/items?")) return false;
          const query = new URL(call.url, "http://localhost").searchParams;
          return (
            query.get("brandId") === OTHER_BRAND_ID &&
            !query.has("sourceId") &&
            !query.has("search") &&
            !query.has("minScorePercent")
          );
        }),
      ).toBe(true),
    );
  });

  it("lets a slow same-query response finish while polling", async () => {
    install();
    const fallbackFetch = vi.mocked(fetch).getMockImplementation();
    const intervals: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval.bind(globalThis);
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      if (typeof handler === "function") intervals.push(handler as () => void);
      return realSetInterval(handler, delay);
    });
    let resolveItems: ((response: Response) => void) | undefined;
    let itemRequests = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).includes("/api/sources/items?")) {
        itemRequests++;
        if (itemRequests === 1) {
          return new Promise<Response>((resolve) => {
            resolveItems = resolve;
          });
        }
      }
      if (!fallbackFetch) throw new Error("Fetch fixture missing");
      return fallbackFetch(input, init);
    });
    try {
      await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
      expect(itemRequests).toBe(1);
      await act(async () => intervals[0]?.());
      expect(itemRequests).toBe(1);
      await act(async () =>
        resolveItems?.(
          response(200, [
            {
              id: ITEM_ID,
              title: "Slow result",
              url: "https://example.com/slow",
              publishedAt: null,
              createdAt: "2026-09-23T12:00:00.000Z",
              relevanceStatus: "unscored",
              relevanceScore: null,
              relevanceReason: null,
              relevanceUrgency: null,
              relevanceErrorCode: null,
              relevanceScoredAt: null,
            },
          ]),
        ),
      );
      expect(await screen.findByText("Slow result")).toBeInTheDocument();
      await act(async () => intervals[0]?.());
      expect(itemRequests).toBe(2);
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("ignores an older search response after a newer query finishes", async () => {
    install();
    const fallbackFetch = vi.mocked(fetch).getMockImplementation();
    let resolveFirst: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const query = new URL(String(input), "http://localhost").searchParams.get("search");
      if (String(input).includes("/api/sources/items?") && query === "first") {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (String(input).includes("/api/sources/items?") && query === "second") {
        return Promise.resolve(
          response(200, [
            {
              id: ITEM_ID,
              title: "Second result",
              url: "https://example.com/second",
              publishedAt: null,
              createdAt: "2026-09-23T12:00:00.000Z",
              relevanceStatus: "unscored",
              relevanceScore: null,
              relevanceReason: null,
              relevanceUrgency: null,
              relevanceErrorCode: null,
              relevanceScoredAt: null,
            },
          ]),
        );
      }
      if (!fallbackFetch) throw new Error("Fetch fixture missing");
      return fallbackFetch(input, init);
    });
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    const input = screen.getByLabelText(en.Sources.searchLabel);
    await user.type(input, "first");
    await waitFor(() => expect(resolveFirst).toBeDefined());
    await user.clear(input);
    await user.type(input, "second");
    expect(await screen.findByText("Second result")).toBeInTheDocument();
    await act(async () => {
      resolveFirst?.(response(200, [{ id: "old", title: "First result" }]));
    });
    expect(screen.queryByText("First result")).not.toBeInTheDocument();
    expect(screen.getByText("Second result")).toBeInTheDocument();
  });

  it("shows a Telegram story's discussion status and queues a bounded collection", async () => {
    const item = {
      id: ITEM_ID,
      brandId: BRAND_ID,
      sourceId: SOURCE_ID,
      title: "Channel story",
      summary: "A story from the channel.",
      url: "https://t.me/example_channel/42",
      publishedAt: null,
      commentsStatus: "unavailable",
      commentsCheckedAt: "2026-09-23T12:00:00.000Z",
      commentsErrorCode: null,
      createdAt: "2026-09-23T12:00:00.000Z",
    };
    const calls = install(
      [item],
      [
        {
          id: SOURCE_ID,
          kind: "telegram",
          isActive: true,
          name: "Channel",
          url: "https://t.me/example_channel",
        },
      ],
    );
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Sources.comments }));
    const dialog = within(screen.getByRole("dialog", { name: en.Sources.commentsTitle }));
    expect(dialog.getByText(en.Sources.commentsUnavailable)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: en.Sources.collectComments }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.url.includes(`/items/${ITEM_ID}/comments/refresh?brandId=${BRAND_ID}`),
        ),
      ).toBe(true),
    );
  });

  it("shows an explicit no-key state and runs analysis only on a manual request", async () => {
    const item = {
      id: ITEM_ID,
      brandId: BRAND_ID,
      sourceId: SOURCE_ID,
      title: "Channel story",
      summary: "A story from the channel.",
      url: "https://t.me/example_channel/42",
      publishedAt: null,
      commentsStatus: "available",
      commentsCheckedAt: "2026-09-23T12:00:00.000Z",
      commentsErrorCode: null,
      createdAt: "2026-09-23T12:00:00.000Z",
    };
    const source = { id: SOURCE_ID, kind: "telegram", isActive: true, name: "Channel" };
    const calls = install([item], [source], { status: "no_key" });
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Sources.comments }));
    const dialog = within(screen.getByRole("dialog", { name: en.Sources.commentsTitle }));
    expect(await dialog.findByText(en.Sources.analysis_no_key)).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: en.Sources.analyzeComments })).toBeNull();
    expect(dialog.getByRole("link", { name: en.Sources.analysisSetupKey })).toHaveAttribute(
      "href",
      "/en/settings",
    );
    expect(
      calls.some((call) => call.method === "POST" && call.url.includes("comment-analysis")),
    ).toBe(false);
  });

  it("renders aggregate analysis after a deliberate click", async () => {
    const item = {
      id: ITEM_ID,
      brandId: BRAND_ID,
      sourceId: SOURCE_ID,
      title: "Story",
      summary: "Summary",
      url: "https://t.me/example_channel/42",
      publishedAt: null,
      commentsStatus: "available",
      commentsCheckedAt: "2026-09-23T12:00:00.000Z",
      commentsErrorCode: null,
      createdAt: "2026-09-23T12:00:00.000Z",
    };
    const source = { id: SOURCE_ID, kind: "telegram", isActive: true, name: "Channel" };
    const calls = install([item], [source], { status: "not_analyzed" });
    await renderAsync(<SourcesPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Sources.comments }));
    const dialog = within(screen.getByRole("dialog", { name: en.Sources.commentsTitle }));
    expect(await dialog.findByText(en.Sources.analysis_not_analyzed)).toBeInTheDocument();
    expect(
      calls.some((call) => call.method === "POST" && call.url.includes("comment-analysis")),
    ).toBe(false);
    await user.click(dialog.getByRole("button", { name: en.Sources.analyzeComments }));
    expect(await dialog.findByText("Readers ask about pricing.")).toBeInTheDocument();
    expect(dialog.getByText("Pricing (1)")).toBeInTheDocument();
    expect(dialog.getByText("Clarify the pricing.")).toBeInTheDocument();
    expect(
      calls.some((call) => call.method === "POST" && call.url.includes("comment-analysis")),
    ).toBe(true);
  });
});
