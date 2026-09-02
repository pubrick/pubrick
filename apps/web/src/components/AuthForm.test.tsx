import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigationState, routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor } from "@/test/render";
import en from "../../messages/en.json";
import { AuthForm } from "./AuthForm";

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

// The real client type is generated from server-side plugin inference and is
// impractical to satisfy in a hand-written mock; the module is fully replaced
// above, so a single cast here is safer than fighting that type per call site.
type MockAuthClient = {
  signIn: { email: ReturnType<typeof vi.fn> };
  signUp: { email: ReturnType<typeof vi.fn> };
};
const mockAuthClient = authClient as unknown as MockAuthClient;

beforeEach(() => {
  mockAuthClient.signIn.email.mockReset();
  mockAuthClient.signUp.email.mockReset();
});

async function fillLogin(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(en.Auth.email), "ann@example.com");
  await user.type(screen.getByLabelText(en.Auth.password), "hunter22222");
}

describe("AuthForm — login mode", () => {
  it("submits signIn.email with the typed credentials and navigates to the locale root", async () => {
    mockAuthClient.signIn.email.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    render(<AuthForm mode="login" />);
    const user = userEvent.setup();
    await fillLogin(user);
    await user.click(screen.getByRole("button", { name: en.Auth.loginAction }));

    await waitFor(() =>
      expect(mockAuthClient.signIn.email).toHaveBeenCalledWith({
        email: "ann@example.com",
        password: "hunter22222",
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith("/en");
    expect(mockAuthClient.signUp.email).not.toHaveBeenCalled();
  });

  it("renders the client's error message and does not navigate", async () => {
    mockAuthClient.signIn.email.mockResolvedValue({
      data: null,
      error: { message: "Invalid credentials" },
    });
    render(<AuthForm mode="login" />);
    const user = userEvent.setup();
    await fillLogin(user);
    await user.click(screen.getByRole("button", { name: en.Auth.loginAction }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Invalid credentials");
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("disables the submit button while the request is in flight, and re-enables it after", async () => {
    let resolveSignIn!: (value: { data: unknown; error: null }) => void;
    mockAuthClient.signIn.email.mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    render(<AuthForm mode="login" />);
    const user = userEvent.setup();
    await fillLogin(user);
    const button = screen.getByRole("button", { name: en.Auth.loginAction });

    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(button).toBeDisabled();

    resolveSignIn({ data: { user: { id: "u1" } }, error: null });
    await waitFor(() => expect(button).not.toBeDisabled());
  });
});

describe("AuthForm — signup mode", () => {
  it("submits signUp.email with name, email and password, and navigates to onboarding", async () => {
    mockAuthClient.signUp.email.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    render(<AuthForm mode="signup" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Auth.name), "Ann Author");
    await user.type(screen.getByLabelText(en.Auth.email), "ann@example.com");
    await user.type(screen.getByLabelText(en.Auth.password), "hunter22222");
    await user.click(screen.getByRole("button", { name: en.Auth.signupAction }));

    await waitFor(() =>
      expect(mockAuthClient.signUp.email).toHaveBeenCalledWith({
        email: "ann@example.com",
        password: "hunter22222",
        name: "Ann Author",
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith("/en/onboarding");
    expect(mockAuthClient.signIn.email).not.toHaveBeenCalled();
  });

  it("renders the client's error message and does not navigate", async () => {
    mockAuthClient.signUp.email.mockResolvedValue({
      data: null,
      error: { message: "Email already registered" },
    });
    render(<AuthForm mode="signup" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Auth.name), "Ann Author");
    await user.type(screen.getByLabelText(en.Auth.email), "ann@example.com");
    await user.type(screen.getByLabelText(en.Auth.password), "hunter22222");
    await user.click(screen.getByRole("button", { name: en.Auth.signupAction }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Email already registered");
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});

describe("AuthForm — the return path AppShell's guard attaches", () => {
  beforeEach(() => {
    mockAuthClient.signIn.email.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  });

  async function login() {
    render(<AuthForm mode="login" />);
    const user = userEvent.setup();
    await fillLogin(user);
    await user.click(screen.getByRole("button", { name: en.Auth.loginAction }));
  }

  it("returns the person to the page they were bounced off", async () => {
    // Without this the guard's `?next=` is decoration: you are sent to login
    // from the queue and land on the locale root.
    navigationState.searchParams = new URLSearchParams("next=/en/content/42");
    await login();

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/content/42"));
  });

  it("ignores a next that points off-site", async () => {
    // `?next=` is attacker-controllable — a crafted link would otherwise make
    // our own login screen a redirector to somebody else's page.
    navigationState.searchParams = new URLSearchParams("next=//evil.example/steal");
    await login();

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en"));
  });

  it("sends a brand-new account to onboarding regardless of next", async () => {
    // A fresh signup has no organization, so every org-scoped destination
    // would 403 on arrival.
    mockAuthClient.signUp.email.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    navigationState.searchParams = new URLSearchParams("next=/en/settings");
    render(<AuthForm mode="signup" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Auth.name), "Ann Author");
    await fillLogin(user);
    await user.click(screen.getByRole("button", { name: en.Auth.signupAction }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/onboarding"));
  });
});
