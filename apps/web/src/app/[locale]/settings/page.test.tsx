import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as theme from "@/lib/theme";
import { render, screen, within } from "@/test/render";
import en from "../../../../messages/en.json";
import SettingsPage from "./page";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
    useActiveOrganization: vi.fn(),
    signOut: vi.fn(),
  },
}));

import { authClient } from "@/lib/auth-client";

type MockAuthClient = {
  useSession: ReturnType<typeof vi.fn>;
  useActiveOrganization: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
};
const mockAuthClient = authClient as unknown as MockAuthClient;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  mockAuthClient.useSession.mockReset();
  mockAuthClient.useActiveOrganization.mockReset();
  mockAuthClient.signOut.mockReset();

  mockAuthClient.useSession.mockReturnValue({
    data: { user: { id: "u1", email: "ann@example.com" } },
    isPending: false,
  });
  mockAuthClient.useActiveOrganization.mockReturnValue({
    data: { id: "org1", name: "Acme Media" },
    isPending: false,
  });
});

describe("Settings — Appearance", () => {
  it('calls applyTheme("dark") and the choice persists via readThemePref', async () => {
    const applyThemeSpy = vi.spyOn(theme, "applyTheme");
    render(<SettingsPage />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: en.SettingsPage.themeDark }));

    expect(applyThemeSpy).toHaveBeenCalledWith("dark");
    expect(theme.readThemePref()).toBe("dark");
    expect(screen.getByRole("tab", { name: en.SettingsPage.themeDark })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("starts from whatever readThemePref() already reports", () => {
    theme.applyTheme("light");
    render(<SettingsPage />);

    expect(screen.getByRole("tab", { name: en.SettingsPage.themeLight })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("Settings — Account", () => {
  it("shows the signed-in email and signs out via the shared Landing.signOut button", async () => {
    render(<SettingsPage />);
    // AppShell's own sidebar user block also shows the email — scope to the
    // page content so this only asserts on the Account card's copy.
    const main = within(screen.getByRole("main"));

    expect(main.getByText("ann@example.com")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(main.getByRole("button", { name: en.Landing.signOut }));

    expect(mockAuthClient.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("Settings — Workspace", () => {
  it("shows the active organization's name, read-only", () => {
    render(<SettingsPage />);

    expect(screen.getByText("Acme Media")).toBeInTheDocument();
  });

  it("falls back to the no-organization copy when there is none", () => {
    mockAuthClient.useActiveOrganization.mockReturnValue({ data: null, isPending: false });
    render(<SettingsPage />);

    expect(screen.getByText(en.SettingsPage.workspaceNoOrg)).toBeInTheDocument();
  });
});
