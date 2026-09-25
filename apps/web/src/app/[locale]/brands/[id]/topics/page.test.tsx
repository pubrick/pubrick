import { refusalBody } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { fireEvent, renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import es from "../../../../../../messages/es.json";
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
      if (url.includes("/api/topics/suggestions?")) return response(200, { request: null });
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
            origin: "manual",
            plannedDate: null,
            priority: 5,
            revision: 1,
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
    expect(screen.getByRole("link", { name: en.Topics.schedule })).toHaveAttribute(
      "href",
      `/en/brands/${BRAND_ID}/calendar?topicId=${TOPIC_ID}`,
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
    await user.selectOptions(dialog.getByLabelText(en.Topics.runFormat), "expert_article");
    await user.click(dialog.getByText(en.Topics.seoOptions));
    await user.type(dialog.getByLabelText(en.Topics.seoKeywordsLabel), "local market hall");
    await user.click(dialog.getByRole("button", { name: en.Topics.generate }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: expect.stringContaining(`/api/topics/${TOPIC_ID}/run?brandId=${BRAND_ID}`),
        method: "POST",
        body: {
          channelIds: [CHANNEL_ID],
          contentType: "expert_article",
          seoKeywords: ["local market hall"],
        },
      }),
    );
  });

  it("requests suggestions, shows queued feedback, and does not generate automatically", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const queued = {
      id: "749d9a5e-06f8-4b40-9b83-a33a6e69482a",
      brandId: BRAND_ID,
      status: "queued",
      errorCode: null,
      suggestionCount: 0,
      createdAt: "2026-09-23T12:00:00Z",
      updatedAt: "2026-09-23T12:00:00Z",
    };
    let request: typeof queued | null = null;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/channels?")) return response(200, []);
      if (url.includes("/api/topics/suggestions?")) {
        if (method === "POST") request = queued;
        return response(200, method === "POST" ? request : { request });
      }
      if (url.includes("/api/topics?")) return response(200, []);
      return response(200, {});
    });
    await renderAsync(<TopicsPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Topics.suggest }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(en.Topics.suggestionWorking),
    );
    expect(calls).toContainEqual({
      url: expect.stringContaining(`/api/topics/suggestions?brandId=${BRAND_ID}`),
      method: "POST",
    });
    expect(calls.some((call) => call.url.includes("/run"))).toBe(false);
  });

  it("blocks with a reason and offers only unblock for the blocked topic", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let blocked = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/channels?")) return response(200, []);
      if (url.includes("/api/topics/suggestions?")) return response(200, { request: null });
      if (url.includes("/block?")) blocked = true;
      if (url.includes("/unblock?")) blocked = false;
      if (url.includes("/api/topics?"))
        return response(200, [
          {
            id: TOPIC_ID,
            brandId: BRAND_ID,
            title: "Avoid this",
            description: "",
            status: blocked ? "archived" : "idea",
            blockedAt: blocked ? "2026-09-23T12:00:00Z" : null,
            blockReason: blocked ? "Off brand" : null,
            origin: "manual",
            plannedDate: null,
            priority: 5,
            revision: blocked ? 2 : 1,
          },
        ]);
      return response(200, {});
    });
    await renderAsync(<TopicsPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Topics.more }));
    await user.click(screen.getByRole("menuitem", { name: en.Topics.block }));
    const dialog = within(screen.getByRole("dialog", { name: en.Topics.blockTitle }));
    await user.type(dialog.getByRole("textbox", { name: en.Topics.blockReasonLabel }), "Off brand");
    await user.click(dialog.getByRole("button", { name: en.Topics.block }));
    await waitFor(() => expect(screen.getByText(en.Topics.status_blocked)).toBeInTheDocument());
    expect(calls).toContainEqual({
      url: expect.stringContaining(`/api/topics/${TOPIC_ID}/block?brandId=${BRAND_ID}`),
      method: "POST",
      body: { reason: "Off brand" },
    });
    await user.click(screen.getByRole("button", { name: en.Topics.more }));
    expect(screen.getByRole("menuitem", { name: en.Topics.unblock })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: en.Topics.remove })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: en.Topics.unblock }));
    await waitFor(() => expect(screen.getByText(en.Topics.status_idea)).toBeInTheDocument());
  });

  it("shows a blocked-topic refusal in the reader's language", async () => {
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/channels?")) return response(200, []);
      if (url.includes("/api/topics/suggestions?")) return response(200, { request: null });
      if (url.includes("/api/topics?"))
        return response(200, [
          {
            id: TOPIC_ID,
            brandId: BRAND_ID,
            title: "Avoid this",
            description: "",
            status: "idea",
            blockedAt: null,
            blockReason: null,
            origin: "manual",
            plannedDate: null,
            priority: 5,
            revision: 1,
          },
        ]);
      if (url.includes("/block?") && init?.method === "POST")
        return response(
          409,
          refusalBody(409, "topic_blocked", "Unblock this topic before editing it"),
        );
      return response(200, {});
    });
    await renderAsync(<TopicsPage params={Promise.resolve({ id: BRAND_ID })} />, { locale: "es" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: es.Topics.more }));
    await user.click(screen.getByRole("menuitem", { name: es.Topics.block }));
    const dialog = within(screen.getByRole("dialog", { name: es.Topics.blockTitle }));
    await user.type(dialog.getByRole("textbox", { name: es.Topics.blockReasonLabel }), "No encaja");
    await user.click(dialog.getByRole("button", { name: es.Topics.block }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(es.Errors.topic_blocked);
    expect(dialog.getByRole("alert")).not.toHaveTextContent("Unblock this topic");
  });

  it("shows saved expert keywords and can clear them for one run", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/channels?"))
        return response(200, [{ id: CHANNEL_ID, name: "Updates", platform: "telegram" }]);
      if (url.includes("/api/topics/suggestions?")) return response(200, { request: null });
      if (url.includes("/api/topics?"))
        return response(200, [
          {
            id: TOPIC_ID,
            title: "Expert guide",
            description: "Facts",
            status: "approved",
            origin: "manual",
            contentType: "expert_article",
            seoKeywords: ["local guide"],
            plannedDate: null,
            priority: 5,
          },
        ]);
      if (url.includes("/run?"))
        return response(201, { id: "c8c29afd-6316-4e39-a7f1-3399d7063b80" });
      return response(200, {});
    });
    await renderAsync(<TopicsPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Topics.generate }));
    const dialog = within(screen.getByRole("dialog", { name: en.Topics.runTitle }));
    expect(dialog.getByLabelText(en.Topics.runFormat)).toHaveValue("expert_article");
    expect(dialog.getByLabelText(en.Topics.seoKeywordsLabel)).toBeVisible();
    await user.clear(dialog.getByLabelText(en.Topics.seoKeywordsLabel));
    await user.click(dialog.getByRole("checkbox", { name: /Updates/ }));
    await user.click(dialog.getByRole("button", { name: en.Topics.generate }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: expect.stringContaining(`/api/topics/${TOPIC_ID}/run?brandId=${BRAND_ID}`),
        method: "POST",
        body: { channelIds: [CHANNEL_ID], seoKeywords: [] },
      }),
    );
  });

  it("saves an optional target date and priority without generating or approving", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method, body });
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/channels?")) return response(200, []);
      if (url.includes("/api/topics/suggestions?")) return response(200, { request: null });
      if (url.includes("/api/topics?") || url.endsWith("/api/topics"))
        return response(method === "POST" ? 201 : 200, method === "POST" ? body : []);
      return response(200, {});
    });
    await renderAsync(<TopicsPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: en.Topics.name }), "Product launch");
    await user.click(screen.getByText(en.Ui.advanced));
    fireEvent.change(screen.getByLabelText(en.Topics.plannedDate), {
      target: { value: "2026-10-10" },
    });
    await user.clear(screen.getByLabelText(en.Topics.priority));
    await user.type(screen.getByLabelText(en.Topics.priority), "8");
    await user.selectOptions(screen.getByLabelText(en.Topics.runFormat), "expert_article");
    await user.type(screen.getByLabelText(en.Topics.seoKeywordsLabel), "local launch guide");
    await user.click(screen.getByRole("button", { name: en.Topics.add }));
    await waitFor(() =>
      expect(
        requests.find((entry) => entry.method === "POST" && entry.url.endsWith("/api/topics"))
          ?.body,
      ).toMatchObject({
        brandId: BRAND_ID,
        title: "Product launch",
        plannedDate: "2026-10-10",
        priority: 8,
        contentType: "expert_article",
        seoKeywords: ["local launch guide"],
      }),
    );
    expect(requests.some((entry) => entry.url.includes("/run"))).toBe(false);
  });

  it("changes an approved topic's date without resubmitting its reviewed brief", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    const topic = {
      id: TOPIC_ID,
      brandId: BRAND_ID,
      newsItemId: null,
      title: "Reviewed launch",
      description: "Approved details",
      sourceUrl: null,
      status: "approved",
      origin: "manual",
      plannedDate: null,
      priority: 5,
      revision: 2,
      createdAt: "2026-09-23T12:00:00Z",
      updatedAt: "2026-09-23T12:00:00Z",
    };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ method, body });
      if (url.includes("/api/brands/")) return response(200, { id: BRAND_ID, name: "Acme" });
      if (url.includes("/api/channels?")) return response(200, []);
      if (url.includes("/api/topics/suggestions?")) return response(200, { request: null });
      if (url.includes(`/api/topics/${TOPIC_ID}`)) return response(200, { ...topic, ...body });
      if (url.includes("/api/topics?")) return response(200, [topic]);
      return response(200, {});
    });
    await renderAsync(<TopicsPage params={Promise.resolve({ id: BRAND_ID })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Topics.more }));
    await user.click(screen.getByRole("menuitem", { name: en.Topics.edit }));
    const dialog = within(screen.getByRole("dialog", { name: en.Topics.editTitle }));
    await user.click(dialog.getByText(en.Ui.advanced));
    fireEvent.change(dialog.getByLabelText(en.Topics.plannedDate), {
      target: { value: "2026-10-11" },
    });
    await user.click(dialog.getByRole("button", { name: en.Topics.save }));
    await waitFor(() =>
      expect(requests.find((entry) => entry.method === "PATCH")?.body).toEqual({
        plannedDate: "2026-10-11",
      }),
    );
  });
});
