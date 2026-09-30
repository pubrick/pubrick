import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import { WorkspaceSwitcher } from "./workspace-switcher";

const mocks = vi.hoisted(() => ({ list: vi.fn(), setActive: vi.fn(), navigate: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({
  authClient: { organization: { list: mocks.list, setActive: mocks.setActive } },
}));
vi.mock("@/lib/workspace-navigation", () => ({ navigateToWorkspace: mocks.navigate }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({
    data: [
      { id: "first", name: "First" },
      { id: "second", name: "Second" },
    ],
    error: null,
  });
  mocks.setActive.mockResolvedValue({ data: {}, error: null });
});
it("changes workspace only after explicit confirmation and performs a full navigation", async () => {
  const user = userEvent.setup();
  render(<WorkspaceSwitcher activeId="first" />);
  await user.selectOptions(await screen.findByLabelText("Workspace"), "second");
  expect(mocks.setActive).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Switch" }));
  await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith({ organizationId: "second" }));
  expect(mocks.navigate).toHaveBeenCalledWith("en");
});
it("keeps the current workspace on refused switching and shows a local error", async () => {
  mocks.setActive.mockResolvedValue({ data: null, error: { message: "PRIVATE SERVER DETAILS" } });
  const user = userEvent.setup();
  render(<WorkspaceSwitcher activeId="first" />);
  await user.selectOptions(await screen.findByLabelText("Workspace"), "second");
  await user.click(screen.getByRole("button", { name: "Switch" }));
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Could not switch workspaces. Your current workspace is unchanged.",
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(screen.queryByText("PRIVATE SERVER DETAILS")).not.toBeInTheDocument();
});
it("reports a failed list instead of pretending the user has no workspaces", async () => {
  mocks.list.mockRejectedValue(new Error("network"));
  render(<WorkspaceSwitcher activeId="first" />);
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Your workspaces could not be loaded.",
  );
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});
