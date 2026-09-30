import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigationState } from "@/test/next-navigation.stub";
import { render, screen } from "@/test/render";
import en from "../../messages/en.json";
import { AuthRecoveryForm } from "./AuthRecoveryForm";

vi.mock("@/lib/auth-client", () => ({
  authClient: { requestPasswordReset: vi.fn(), resetPassword: vi.fn() },
}));

import { authClient } from "@/lib/auth-client";

beforeEach(() => {
  vi.mocked(authClient.requestPasswordReset).mockReset();
  vi.mocked(authClient.resetPassword).mockReset();
});
describe("account recovery", () => {
  it("shows a non-enumerating confirmation after a recovery request", async () => {
    vi.mocked(authClient.requestPasswordReset).mockResolvedValue({
      data: { status: true, message: "" },
      error: null,
    });
    render(<AuthRecoveryForm mode="forgot" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Auth.email), "person@example.com");
    await user.click(screen.getByRole("button", { name: en.Auth.sendRecoveryLink }));
    expect(await screen.findByRole("status")).toHaveTextContent(en.Auth.passwordResetSent);
    expect(authClient.requestPasswordReset).toHaveBeenCalledWith(
      { email: "person@example.com", redirectTo: `${window.location.origin}/en/reset-password` },
      { headers: { "x-pubrick-locale": "en" } },
    );
  });
  it("preserves a validated invitation return path through verification and drops a foreign redirect", () => {
    navigationState.searchParams = new URLSearchParams({
      next: "/en/onboarding?invitation=invite",
    });
    const view = render(<AuthRecoveryForm mode="verify" />);
    expect(screen.getByRole("link", { name: en.Auth.backToLogin })).toHaveAttribute(
      "href",
      "/en/login?next=%2Fen%2Fonboarding%3Finvitation%3Dinvite",
    );
    view.unmount();
    navigationState.searchParams = new URLSearchParams({ next: "//evil.example" });
    render(<AuthRecoveryForm mode="verify" />);
    expect(screen.getByRole("link", { name: en.Auth.backToLogin })).toHaveAttribute(
      "href",
      "/en/login",
    );
  });
  it("refuses a missing reset token and offers a new link", () => {
    render(<AuthRecoveryForm mode="reset" />);
    expect(screen.getByRole("alert")).toHaveTextContent(en.Auth.invalidRecoveryLink);
    expect(screen.getByRole("link", { name: en.Auth.requestNewLink })).toHaveAttribute(
      "href",
      "/en/forgot-password",
    );
    expect(authClient.resetPassword).not.toHaveBeenCalled();
  });
  it("compares passwords before submitting a token and clears secrets on success", async () => {
    navigationState.searchParams = new URLSearchParams("token=signed-token");
    vi.mocked(authClient.resetPassword).mockResolvedValue({ data: { status: true }, error: null });
    render(<AuthRecoveryForm mode="reset" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Auth.newPassword), "new-password");
    await user.type(screen.getByLabelText(en.Auth.confirmPassword), "other-password");
    await user.click(screen.getByRole("button", { name: en.Auth.savePassword }));
    expect(screen.getByRole("alert")).toHaveTextContent(en.Auth.passwordMismatch);
    expect(authClient.resetPassword).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText(en.Auth.confirmPassword));
    await user.type(screen.getByLabelText(en.Auth.confirmPassword), "new-password");
    await user.click(screen.getByRole("button", { name: en.Auth.savePassword }));
    expect(await screen.findByRole("status")).toHaveTextContent(en.Auth.passwordResetComplete);
    expect(authClient.resetPassword).toHaveBeenCalledWith({
      newPassword: "new-password",
      token: "signed-token",
    });
    expect(screen.queryByLabelText(en.Auth.newPassword)).not.toBeInTheDocument();
  });
});
