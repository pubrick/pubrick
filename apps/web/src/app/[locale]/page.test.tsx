import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../messages/en.json";
import LandingPage from "./page";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    useSession: vi.fn(),
    organization: { create: vi.fn(), setActive: vi.fn() },
  },
}));

import { authClient } from "@/lib/auth-client";

// See AuthForm.test.tsx for why the real (server-inferred) client type is not
// worth reproducing here — the module is fully replaced by the mock above.
type MockAuthClient = {
  signOut: ReturnType<typeof vi.fn>;
  useSession: ReturnType<typeof vi.fn>;
};
const mockAuthClient = authClient as unknown as MockAuthClient;

beforeEach(() => {
  mockAuthClient.signOut.mockReset();
  mockAuthClient.useSession.mockReset();
});

describe("Landing — signed out", () => {
  it("renders login and signup links, not the signed-in controls", () => {
    mockAuthClient.useSession.mockReturnValue({ data: null, isPending: false });
    render(<LandingPage />);

    expect(screen.getByRole("link", { name: en.Landing.login })).toHaveAttribute(
      "href",
      "/en/login",
    );
    expect(screen.getByRole("link", { name: en.Landing.signup })).toHaveAttribute(
      "href",
      "/en/signup",
    );
    expect(screen.queryByRole("link", { name: en.Landing.goToBrands })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.Landing.signOut })).not.toBeInTheDocument();
  });
});

describe("Landing — signed in", () => {
  it("renders the brands/content links and a working sign-out button", async () => {
    mockAuthClient.useSession.mockReturnValue({
      data: { user: { id: "u1" } },
      isPending: false,
    });
    render(<LandingPage />);

    expect(screen.getByRole("link", { name: en.Landing.goToBrands })).toHaveAttribute(
      "href",
      "/en/brands",
    );
    expect(screen.getByRole("link", { name: en.Landing.goToContent })).toHaveAttribute(
      "href",
      "/en/content",
    );
    expect(screen.queryByRole("link", { name: en.Landing.login })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Landing.signOut }));
    expect(mockAuthClient.signOut).toHaveBeenCalledTimes(1);
  });

  it("leaves for the login screen after signing out, rather than sitting on the signed-in card", async () => {
    mockAuthClient.useSession.mockReturnValue({
      data: { user: { id: "u1" } },
      isPending: false,
    });
    mockAuthClient.signOut.mockResolvedValue(undefined);
    render(<LandingPage />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.Landing.signOut }));

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/en/login"));
  });
});

describe("Landing — isPending", () => {
  it("renders neither signed-out nor signed-in controls while pending, even with session data already present", () => {
    // Session data is truthy here on purpose: if the pending check were ever
    // reordered behind the session check (`session ? … : isPending ? null : …`),
    // this would start rendering the signed-in branch instead of nothing.
    mockAuthClient.useSession.mockReturnValue({
      data: { user: { id: "u1" } },
      isPending: true,
    });
    render(<LandingPage />);

    expect(screen.queryByRole("link", { name: en.Landing.login })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: en.Landing.signup })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: en.Landing.goToBrands })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: en.Landing.goToContent })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.Landing.signOut })).not.toBeInTheDocument();
  });
});
