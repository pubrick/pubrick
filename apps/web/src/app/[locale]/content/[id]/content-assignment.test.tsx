import { type ContentAssignmentDto, contentAssignmentDtoSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { act, render, screen, waitFor, within } from "@/test/render";
import en from "../../../../../messages/en.json";
import { ContentAssignment } from "./content-assignment";

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: mockApi,
}));
const ada = { memberId: "member-ada", userId: "ada", name: "Ada" };
const grace = { memberId: "member-grace", userId: "grace", name: "Grace" };
const cursor = "00000000-0000-4000-8000-000000000002";
const history = (revision = 2) => ({
  id: "00000000-0000-4000-8000-000000000001",
  revision,
  previousName: null,
  assigneeName: "Ada",
  actorName: "Editor",
  createdAt: "2026-10-01T10:00:00.000Z",
});
function state(overrides: Partial<ContentAssignmentDto> = {}) {
  return contentAssignmentDtoSchema.parse({
    revision: 2,
    assignee: { ...ada, eligible: true },
    members: [ada, grace],
    history: { rows: [history()], nextCursor: null },
    ...overrides,
  });
}
beforeEach(() => {
  mockApi.mockReset();
  mockApi.mockResolvedValue(state());
});

describe("responsibility editor", () => {
  it("shows the saved assignee and history to an author without assignment controls", async () => {
    render(<ContentAssignment itemId="post" canAssign={false} />);
    expect(await screen.findByText("Assigned to Ada")).toBeVisible();
    expect(screen.getByText("Editor: Unassigned → Ada")).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.Assignment.save })).not.toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledOnce();
  });

  it("pins the original revision and shows the committed response without replacing composer drafts", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValueOnce(state()).mockResolvedValueOnce(
      state({
        revision: 3,
        assignee: { ...grace, eligible: true },
        history: {
          rows: [{ ...history(3), previousName: "Ada", assigneeName: "Grace" }],
          nextCursor: null,
        },
      }),
    );
    render(<ContentAssignment itemId="post" canAssign />);
    const input = await screen.findByRole("combobox", { name: en.Assignment.label });
    expect(input).toHaveValue(ada.memberId);
    const save = screen.getByRole("button", { name: en.Assignment.save });
    expect(save).toBeDisabled();
    expect(save).toHaveClass("min-h-11");
    expect(input).toHaveClass("min-h-11");
    await user.selectOptions(input, grace.memberId);
    expect(screen.getByRole("status")).toHaveTextContent(en.Assignment.unsaved);
    await user.click(save);
    expect(mockApi).toHaveBeenLastCalledWith("/api/content/post/assignment", {
      method: "PUT",
      body: JSON.stringify({ memberId: grace.memberId, expectedRevision: 2 }),
    });
    expect(await screen.findByText(en.Assignment.saved)).toBeVisible();
    expect(screen.getByText("Assigned to Grace")).toBeVisible();
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(save).toBeDisabled();
  });

  it("retains a refused selection, prevents another stale write, and explicitly reloads a new baseline", async () => {
    const user = userEvent.setup();
    mockApi
      .mockResolvedValueOnce(state())
      .mockRejectedValueOnce(new ApiError(409, "Changed", false, "assignment_changed"))
      .mockResolvedValueOnce(state({ revision: 4, assignee: { ...grace, eligible: true } }))
      .mockResolvedValueOnce(state({ revision: 5, assignee: null }));
    render(<ContentAssignment itemId="post" canAssign />);
    const input = await screen.findByRole("combobox");
    await user.selectOptions(input, grace.memberId);
    await user.click(screen.getByRole("button", { name: en.Assignment.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.Errors.assignment_changed);
    expect(input).toHaveValue(grace.memberId);
    expect(input).toBeDisabled();
    const save = screen.getByRole("button", { name: en.Assignment.save });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(mockApi).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: en.Assignment.reload }));
    await waitFor(() => expect(input).toBeEnabled());
    await user.selectOptions(input, "");
    await user.click(save);
    await screen.findByText(en.Assignment.saved);
    expect(mockApi).toHaveBeenLastCalledWith("/api/content/post/assignment", {
      method: "PUT",
      body: JSON.stringify({ memberId: null, expectedRevision: 4 }),
    });
  });

  it("keeps a removed teammate visible and permits an explicit replacement", async () => {
    const user = userEvent.setup();
    mockApi
      .mockResolvedValueOnce(state({ assignee: { ...ada, eligible: false }, members: [grace] }))
      .mockResolvedValueOnce(
        state({ revision: 3, assignee: { ...grace, eligible: true }, members: [grace] }),
      );
    render(<ContentAssignment itemId="post" canAssign />);
    expect(
      await screen.findByText("Ada no longer has access. Reassign or clear this assignment."),
    ).toBeVisible();
    const input = screen.getByRole("combobox");
    expect(within(input).getByRole("option", { name: "Ada — Unavailable" })).toBeDisabled();
    await user.selectOptions(input, grace.memberId);
    await user.click(screen.getByRole("button", { name: en.Assignment.save }));
    await screen.findByText(en.Assignment.saved);
    expect(screen.getByText("Assigned to Grace")).toBeVisible();
  });

  it("drops a late read from another content item", async () => {
    let finish!: (value: ContentAssignmentDto) => void;
    mockApi
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(state({ assignee: { ...grace, eligible: true } }));
    const view = render(<ContentAssignment itemId="old" canAssign />);
    view.rerender(<ContentAssignment itemId="new" canAssign />);
    await screen.findByText("Assigned to Grace");
    await act(async () => {
      finish(state());
    });
    expect(screen.getByRole("combobox")).toHaveValue(grace.memberId);
    expect(screen.queryByText("Assigned to Ada")).not.toBeInTheDocument();
  });

  it("paginates history without resetting a pending selection and detects a newer saved revision", async () => {
    const user = userEvent.setup();
    mockApi
      .mockResolvedValueOnce(state({ history: { rows: [history()], nextCursor: cursor } }))
      .mockResolvedValueOnce(
        state({
          history: {
            rows: [{ ...history(1), id: cursor, assigneeName: "Grace" }],
            nextCursor: cursor,
          },
        }),
      )
      .mockResolvedValueOnce(state({ revision: 3, history: { rows: [], nextCursor: null } }));
    render(<ContentAssignment itemId="post" canAssign />);
    const input = await screen.findByRole("combobox");
    await user.selectOptions(input, grace.memberId);
    await user.click(screen.getByRole("button", { name: en.Assignment.loadMore }));
    expect(await screen.findByText("Editor: Unassigned → Grace")).toBeVisible();
    expect(input).toHaveValue(grace.memberId);
    await user.click(screen.getByRole("button", { name: en.Assignment.loadMore }));
    expect(await screen.findByRole("alert")).toHaveTextContent(en.Assignment.changed);
    expect(screen.getByRole("button", { name: en.Assignment.save })).toBeDisabled();
  });

  it("clears saved metadata on lost permission and requires a fresh read", async () => {
    const user = userEvent.setup();
    mockApi.mockResolvedValueOnce(state()).mockRejectedValueOnce(new ApiError(403, "{}"));
    render(<ContentAssignment itemId="post" canAssign />);
    await user.selectOptions(await screen.findByRole("combobox"), grace.memberId);
    await user.click(screen.getByRole("button", { name: en.Assignment.save }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Assigned to Ada")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.Assignment.reload })).toBeEnabled();
  });
});
