import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync, screen, waitFor } from "@/test/render";
import en from "../../../../../../messages/en.json";
import BrandAccessPage from "./page";

const members = [
  {
    memberId: "owner",
    userId: "u1",
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
    hasAccess: true,
  },
  {
    memberId: "editor",
    userId: "u2",
    name: "Editor",
    email: "editor@example.com",
    role: "member",
    hasAccess: true,
  },
  {
    memberId: "writer",
    userId: "u3",
    name: "Writer",
    email: "writer@example.com",
    role: "member",
    hasAccess: false,
  },
];

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  signedInSession();
  vi.stubGlobal("fetch", vi.fn());
});

describe("brand member access", () => {
  it("keeps owners immutable and saves only selected member IDs", async () => {
    const requests: unknown[] = [];
    let grants = members;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        requests.push(body);
        grants = members.map((member) => ({
          ...member,
          hasAccess: member.role === "owner" || body.memberIds.includes(member.memberId),
        }));
        return response(200, { members: grants });
      }
      return response(200, { members: grants });
    });

    await renderAsync(<BrandAccessPage params={Promise.resolve({ id: "brand-1" })} />);
    const user = userEvent.setup();
    const owner = screen.getByRole("checkbox", { name: /Owner/ });
    expect(owner).toBeChecked();
    expect(owner).toBeDisabled();
    expect(screen.getByRole("button", { name: en.BrandAccess.save })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /Writer/ }));
    await user.click(screen.getByRole("checkbox", { name: /Editor/ }));
    await user.click(screen.getByRole("button", { name: en.BrandAccess.save }));

    await waitFor(() => expect(requests).toEqual([{ memberIds: ["writer"] }]));
    expect(await screen.findByRole("status")).toHaveTextContent(en.BrandAccess.saved);
    expect(screen.getByRole("button", { name: en.BrandAccess.save })).toBeDisabled();
  });

  it("preserves edits and offers retry when saving fails", async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) =>
      init?.method === "PUT"
        ? response(500, { message: "internal detail" })
        : response(200, { members }),
    );
    await renderAsync(<BrandAccessPage params={Promise.resolve({ id: "brand-1" })} />, {
      locale: "ru",
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: /Writer/ }));
    await user.click(screen.getByRole("button", { name: /Сохранить доступ/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Не удалось сохранить доступ/);
    expect(screen.getByRole("checkbox", { name: /Writer/ })).toBeChecked();
    expect(screen.getByRole("button", { name: /Сохранить доступ/ })).toBeEnabled();
  });

  it("shows a clear denial without member data or save action", async () => {
    vi.mocked(fetch).mockResolvedValue(response(403, { message: "Forbidden" }));
    await renderAsync(<BrandAccessPage params={Promise.resolve({ id: "brand-1" })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.BrandAccess.ownerOnly);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.BrandAccess.save })).not.toBeInTheDocument();
  });
});
