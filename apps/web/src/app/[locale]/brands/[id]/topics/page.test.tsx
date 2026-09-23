import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import TopicsPage from "./page";

const BRAND_ID = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const CHANNEL_ID = "15e678e4-dbd6-4166-996b-9cf9b0cdbf1d";
const TOPIC_ID = "40a21268-4c10-4ad9-b05d-519c11231322";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

describe("topic bank page", () => {
  beforeEach(() => {
    signedInSession();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("approves a saved topic and sends its id and chosen channel to the existing run path", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    let status = "idea";
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/channels?"))
        return response(200, [{ id: CHANNEL_ID, name: "Updates", platform: "telegram" }]);
      if (url.includes("/api/topics?"))
        return response(200, [
          {
            id: TOPIC_ID,
            brandId: BRAND_ID,
            newsItemId: null,
            title: "New hall",
            description: "The council approved it.",
            sourceUrl: "https://example.com/hall",
            status,
            createdAt: "2026-09-23T12:00:00Z",
            updatedAt: "2026-09-23T12:00:00Z",
          },
        ]);
      if (method === "PATCH") {
        status = (body as { status: string }).status;
        return response(200, {});
      }
      if (url.includes("/run?"))
        return response(201, { id: "c8c29afd-6316-4e39-a7f1-3399d7063b80" });
      return response(200, {});
    });

    await renderAsync(<TopicsPage params={Promise.resolve({ id: BRAND_ID })} />);
    await waitFor(() => expect(screen.getByText("New hall")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: en.Topics.openSource })).toHaveAttribute(
      "href",
      "https://example.com/hall",
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Topics.approve }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: en.Topics.generate })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: en.Topics.generate }));
    const dialog = within(screen.getByRole("dialog", { name: en.Topics.runTitle }));
    await user.click(dialog.getByRole("checkbox", { name: /Updates/ }));
    await user.click(dialog.getByRole("button", { name: en.Topics.generate }));
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(expect.stringContaining("/content/runs/")),
    );
    expect(calls).toContainEqual({
      url: expect.stringContaining(`/api/topics/${TOPIC_ID}/run?brandId=${BRAND_ID}`),
      method: "POST",
      body: { channelIds: [CHANNEL_ID] },
    });
  });
});
