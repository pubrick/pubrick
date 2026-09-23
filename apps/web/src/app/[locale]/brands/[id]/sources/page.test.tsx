import { runCreateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import SourcesPage from "./page";

const BRAND_ID = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
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
  });

  function install(items: unknown[] = []) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/sources/items?")) return response(200, items);
      if (url.includes("/api/sources?")) return response(200, []);
      if (url.includes("/api/channels?"))
        return response(200, [{ id: CHANNEL_ID, name: "Updates", platform: "telegram" }]);
      if (url.endsWith("/api/runs"))
        return response(201, { id: "c8c29afd-6316-4e39-a7f1-3399d7063b80" });
      return response(201, {});
    });
    return calls;
  }

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
      url: "https://example.com/feed.xml",
    });
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
});
