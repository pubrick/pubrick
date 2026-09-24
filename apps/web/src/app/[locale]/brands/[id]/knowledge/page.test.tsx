import { knowledgeCreateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/auth-client";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { api } from "@/lib/api";
import KnowledgePage from "./page";

const brandId = "3ac0bec9-c871-40aa-8f8e-1cc8303561b1";
const mockApi = vi.mocked(api);

beforeEach(() => {
  signedInSession();
  mockApi.mockReset();
  vi.mocked(authClient.useActiveOrganization).mockImplementation(
    () =>
      ({
        data: null,
        isPending: false,
      }) as never,
  );
});

describe("brand knowledge screen", () => {
  it("lets an owner explicitly opt in", async () => {
    mockApi.mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/knowledge?")) return [] as never;
      if (String(path).startsWith("/api/knowledge/auto-index?"))
        return { enabled: false, lastAttemptAt: null } as never;
      if (path === "/api/knowledge/auto-index" && init?.method === "PATCH")
        return { enabled: true, lastAttemptAt: null } as never;
      return {} as never;
    });
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "test-org", members: [{ userId: "test-user", role: "owner" }] },
      isPending: false,
    } as never);
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    const toggle = await screen.findByRole("switch", { name: en.Knowledge.autoIndexTitle });
    await userEvent.setup().click(toggle);
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith("/api/knowledge/auto-index", {
        method: "PATCH",
        body: JSON.stringify({ brandId, enabled: true }),
      }),
    );
  });

  it("shows no paid indexing switch to members", async () => {
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "test-org", members: [{ userId: "test-user", role: "member" }] },
      isPending: false,
    } as never);
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?")) return [] as never;
      if (String(path).startsWith("/api/knowledge/auto-index?"))
        return { enabled: false, lastAttemptAt: null } as never;
      return {} as never;
    });
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText(en.Knowledge.autoIndexTitle);
    expect(screen.queryByRole("switch")).toBeNull();
  });
  it("sends a bounded note through the same schema the API validates", async () => {
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?")) return [] as never;
      return {} as never;
    });
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText(en.Knowledge.empty);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: en.Knowledge.add })[0] as HTMLElement);
    const dialog = within(screen.getByRole("dialog"));
    await user.type(
      dialog.getByRole("textbox", { name: en.Knowledge.titleLabel }),
      "Winter espresso",
    );
    await user.type(
      dialog.getByRole("textbox", { name: en.Knowledge.contentLabel }),
      "Arabica beans only.",
    );
    await user.click(dialog.getByRole("button", { name: en.Knowledge.save }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/api/knowledge",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mockApi.mock.calls.find(([path]) => path === "/api/knowledge");
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({
      brandId,
      title: "Winter espresso",
      content: "Arabica beans only.",
      category: "product_info",
      tags: [],
    });
    expect(knowledgeCreateSchema.parse(body)).toEqual(body);
  });

  it("requires a confirmation before removal and addresses the brand in the request", async () => {
    const entry = {
      id: "a4230386-c8ae-4948-a7c9-a10017067a35",
      title: "Espresso",
      content: "Arabica",
      category: "product_info",
      tags: [],
      isActive: true,
      hasEmbedding: false,
    };
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?")) return [entry] as never;
      return { deleted: true } as never;
    });
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText(entry.title);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Knowledge.remove }));
    expect(
      mockApi.mock.calls.some(
        ([path, init]) =>
          path === `/api/knowledge/${entry.id}?brandId=${brandId}` && init?.method === "DELETE",
      ),
    ).toBe(false);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.Knowledge.remove }),
    );
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(`/api/knowledge/${entry.id}?brandId=${brandId}`, {
        method: "DELETE",
      }),
    );
  });

  it("previews CSV and imports the validated batch", async () => {
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?")) return [] as never;
      if (path === "/api/knowledge/bulk-import") return { created: 1 } as never;
      return {} as never;
    });
    const { container } = await renderAsync(
      <KnowledgePage params={Promise.resolve({ id: brandId })} />,
    );
    await screen.findByText(en.Knowledge.empty);
    const csv = new File(
      [
        'title,content,category,tags_json,is_active\nOrigin,Arabica only,product_info,"[""coffee, roasted""]",false\n',
      ],
      "notes.csv",
      { type: "text/csv" },
    );
    Object.defineProperty(csv, "text", {
      value: async () =>
        'title,content,category,tags_json,is_active\nOrigin,Arabica only,product_info,"[""coffee, roasted""]",false\n',
    });
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    const user = userEvent.setup();
    await user.upload(input as HTMLInputElement, csv);
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText(`Origin (${en.Knowledge.paused})`)).toBeInTheDocument();
    expect(mockApi.mock.calls.some(([path]) => path === "/api/knowledge/bulk-import")).toBe(false);
    await user.click(dialog.getByRole("button", { name: en.Knowledge.csvImport }));
    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith(
        "/api/knowledge/bulk-import",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const call = mockApi.mock.calls.find(([path]) => path === "/api/knowledge/bulk-import");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      brandId,
      entries: [
        {
          title: "Origin",
          content: "Arabica only",
          category: "product_info",
          tags: ["coffee, roasted"],
          isActive: false,
        },
      ],
    });
  });
});
