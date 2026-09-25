import { knowledgeCreateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/auth-client";
import { signedInSession } from "@/test/auth-client.stub";
import { act, renderAsync, screen, waitFor, within } from "@/test/render";
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
        data: { id: "test-org", members: [{ userId: "test-user", role: "member" }] },
        isPending: false,
      }) as never,
  );
});

describe("brand knowledge screen", () => {
  it.each(["author", "editor"])(
    "shows %s saved knowledge without rejected actions",
    async (role) => {
      vi.mocked(authClient.useActiveOrganization).mockReturnValue({
        data: { id: "test-org", members: [{ userId: "test-user", role }] },
        isPending: false,
      } as never);
      mockApi.mockImplementation(async (path) => {
        if (String(path).startsWith("/api/knowledge?"))
          return [
            {
              id: "7d761194-a149-4bba-bae9-76ab72e1eda7",
              title: "Shared facts",
              content: "Reviewable facts",
              category: "product_info",
              tags: [],
              isActive: true,
              hasEmbedding: false,
            },
          ] as never;
        if (String(path).startsWith("/api/knowledge/auto-index?"))
          return { enabled: false, lastAttemptAt: null } as never;
        return {} as never;
      });

      await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
      expect(await screen.findByText("Shared facts")).toBeVisible();
      expect(screen.getByText(en.Knowledge.autoIndexOff)).toBeVisible();
      expect(screen.getByRole("button", { name: en.Knowledge.csvExport })).toBeInTheDocument();
      for (const label of [
        en.Knowledge.add,
        en.Knowledge.csvImport,
        en.Knowledge.batchAction,
        en.Knowledge.index,
        en.Knowledge.edit,
        en.Knowledge.pause,
        en.Knowledge.remove,
      ]) {
        expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
      }
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    },
  );

  it("keeps existing note controls for a workspace member", async () => {
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "test-org", members: [{ userId: "test-user", role: "member" }] },
      isPending: false,
    } as never);
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?"))
        return [
          {
            id: "7d761194-a149-4bba-bae9-76ab72e1eda7",
            title: "Shared facts",
            content: "Reviewable facts",
            category: "product_info",
            tags: [],
            isActive: true,
            hasEmbedding: false,
          },
        ] as never;
      return {} as never;
    });

    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    expect(await screen.findByText("Shared facts")).toBeVisible();
    expect(screen.getByRole("button", { name: en.Knowledge.csvImport })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Knowledge.edit })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Knowledge.pause })).toBeInTheDocument();
  });

  it("shows a custom category literally and filters notes for the selected brand", async () => {
    const notes = [
      {
        id: "7d761194-a149-4bba-bae9-76ab72e1eda7",
        title: "Partner note",
        content: "Facts",
        category: "Retail Partners",
        tags: [],
        isActive: true,
        hasEmbedding: true,
      },
      {
        id: "e45c3e74-1b58-409b-a1c2-91e610ab5995",
        title: "Product note",
        content: "Facts",
        category: "product_info",
        tags: [],
        isActive: true,
        hasEmbedding: false,
      },
    ];
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?")) return notes as never;
      return {} as never;
    });
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText("Partner note");
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.Knowledge.filterCategory }),
      "Retail Partners",
    );
    expect(screen.getByText("Partner note")).toBeInTheDocument();
    expect(screen.queryByText("Product note")).toBeNull();
    expect(screen.getByText("Retail Partners · Active · Vector indexed")).toBeInTheDocument();
  });

  it("clears the filter after removing its last note", async () => {
    const custom = {
      id: "7d761194-a149-4bba-bae9-76ab72e1eda7",
      title: "Partner note",
      content: "Facts",
      category: "Retail Partners",
      tags: [],
      isActive: true,
      hasEmbedding: false,
    };
    const preset = {
      ...custom,
      id: "e45c3e74-1b58-409b-a1c2-91e610ab5995",
      title: "Product note",
      category: "product_info",
    };
    let notes = [custom, preset];
    mockApi.mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/knowledge?")) return notes as never;
      if (String(path).includes(custom.id) && init?.method === "DELETE") notes = [preset];
      return {} as never;
    });
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText("Partner note");
    const user = userEvent.setup();
    const filter = screen.getByRole("combobox", { name: en.Knowledge.filterCategory });
    await user.selectOptions(filter, "Retail Partners");
    await user.click(screen.getByRole("button", { name: en.Knowledge.remove }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.Knowledge.remove }),
    );
    await screen.findByText("Product note");
    await waitFor(() => expect(filter).toHaveValue(""));
    expect(screen.queryByRole("option", { name: "Retail Partners" })).toBeNull();
  });

  it("clears the filter after reclassifying its last note", async () => {
    let note = {
      id: "7d761194-a149-4bba-bae9-76ab72e1eda7",
      title: "Partner note",
      content: "Facts",
      category: "Retail Partners",
      tags: [],
      isActive: true,
      hasEmbedding: true,
    };
    mockApi.mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/knowledge?")) return [note] as never;
      if (String(path).includes(note.id) && init?.method === "PATCH") {
        note = { ...note, category: "product_info" };
      }
      return {} as never;
    });
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText("Partner note");
    const user = userEvent.setup();
    const filter = screen.getByRole("combobox", { name: en.Knowledge.filterCategory });
    await user.selectOptions(filter, "Retail Partners");
    await user.click(screen.getByRole("button", { name: en.Knowledge.edit }));
    const dialog = within(screen.getByRole("dialog"));
    await user.selectOptions(
      dialog.getByRole("combobox", { name: en.Knowledge.categoryLabel }),
      "product_info",
    );
    await user.click(dialog.getByRole("button", { name: en.Knowledge.save }));
    await waitFor(() => expect(filter).toHaveValue(""));
    expect(screen.getByText("Partner note")).toBeInTheDocument();
  });

  it("clears the filter when navigating to another brand", async () => {
    const otherBrandId = "ed460d4c-33b3-4a8b-8296-f30cd560f157";
    const custom = {
      id: "7d761194-a149-4bba-bae9-76ab72e1eda7",
      title: "Partner note",
      content: "Facts",
      category: "Retail Partners",
      tags: [],
      isActive: true,
      hasEmbedding: false,
    };
    const other = {
      ...custom,
      id: "e45c3e74-1b58-409b-a1c2-91e610ab5995",
      title: "Other brand note",
      category: "product_info",
    };
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?")) {
        return (String(path).includes(otherBrandId) ? [other] : [custom]) as never;
      }
      return {} as never;
    });
    const view = await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText("Partner note");
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.Knowledge.filterCategory }),
      "Retail Partners",
    );
    await act(async () => {
      view.rerender(<KnowledgePage params={Promise.resolve({ id: otherBrandId })} />);
    });
    await screen.findByText("Other brand note");
    expect(screen.getByRole("combobox", { name: en.Knowledge.filterCategory })).toHaveValue("");
    expect(screen.queryByText("Partner note")).toBeNull();
  });

  it("creates a note with an explicitly entered custom category", async () => {
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?")) return [] as never;
      return {} as never;
    });
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText(en.Knowledge.empty);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: en.Knowledge.add })[0] as HTMLElement);
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByRole("textbox", { name: en.Knowledge.titleLabel }), "Partner note");
    await user.type(dialog.getByRole("textbox", { name: en.Knowledge.contentLabel }), "Facts");
    await user.selectOptions(
      dialog.getByRole("combobox", { name: en.Knowledge.categoryLabel }),
      "__custom__",
    );
    await user.type(
      dialog.getByRole("textbox", { name: en.Knowledge.customCategoryLabel }),
      "Retail Partners",
    );
    await user.click(dialog.getByRole("button", { name: en.Knowledge.save }));
    const call = mockApi.mock.calls.find(([path]) => path === "/api/knowledge");
    expect(JSON.parse(String(call?.[1]?.body)).category).toBe("Retail Partners");
  });

  it("patches only the category when editing an indexed note", async () => {
    const note = {
      id: "7d761194-a149-4bba-bae9-76ab72e1eda7",
      title: "Partner note",
      content: "Facts",
      category: "product_info",
      tags: ["coffee, roasted"],
      isActive: true,
      hasEmbedding: true,
    };
    mockApi.mockImplementation(async (path) => {
      if (String(path).startsWith("/api/knowledge?")) return [note] as never;
      return {} as never;
    });
    await renderAsync(<KnowledgePage params={Promise.resolve({ id: brandId })} />);
    await screen.findByText("Partner note");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Knowledge.edit }));
    const dialog = within(screen.getByRole("dialog"));
    await user.selectOptions(
      dialog.getByRole("combobox", { name: en.Knowledge.categoryLabel }),
      "__custom__",
    );
    await user.type(
      dialog.getByRole("textbox", { name: en.Knowledge.customCategoryLabel }),
      "Retail Partners",
    );
    await user.click(dialog.getByRole("button", { name: en.Knowledge.save }));
    await waitFor(() => {
      const call = mockApi.mock.calls.find(
        ([path, init]) =>
          path === `/api/knowledge/${note.id}?brandId=${brandId}` && init?.method === "PATCH",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ category: "Retail Partners" });
    });
  });
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
