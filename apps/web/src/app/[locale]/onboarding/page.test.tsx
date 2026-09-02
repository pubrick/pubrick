import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orgSlug } from "@/lib/slug";
import { routerMock } from "@/test/next-navigation.stub";
import { act, render, screen, waitFor } from "@/test/render";
import en from "../../../../messages/en.json";
import OnboardingPage from "./page";

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
  organization: {
    create: ReturnType<typeof vi.fn>;
    setActive: ReturnType<typeof vi.fn>;
  };
};
const mockAuthClient = authClient as unknown as MockAuthClient;

beforeEach(() => {
  mockAuthClient.organization.create.mockReset();
  mockAuthClient.organization.setActive.mockReset();
  // orgSlug appends a random suffix; pin Math.random so the component's call
  // and the test's expected-value computation agree on the exact slug.
  vi.spyOn(Math, "random").mockReturnValue(0.123456789);
});

async function fillAndSubmit(orgName: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(en.Onboarding.orgName), orgName);
  await user.click(screen.getByRole("button", { name: en.Onboarding.create }));
}

describe("Onboarding — happy path", () => {
  it("creates the org with a slug from orgSlug, activates it, and navigates to brands", async () => {
    mockAuthClient.organization.create.mockResolvedValue({
      data: { id: "org-1" },
      error: null,
    });
    mockAuthClient.organization.setActive.mockResolvedValue({ data: {}, error: null });
    render(<OnboardingPage />);

    const expectedSlug = orgSlug("Acme Corp");
    await fillAndSubmit("Acme Corp");

    await waitFor(() =>
      expect(mockAuthClient.organization.create).toHaveBeenCalledWith({
        name: "Acme Corp",
        slug: expectedSlug,
      }),
    );
    await waitFor(() =>
      expect(mockAuthClient.organization.setActive).toHaveBeenCalledWith({
        organizationId: "org-1",
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith("/en/brands");
  });
});

describe("Onboarding — organization.create fails", () => {
  it("renders the error, does not activate, and does not navigate", async () => {
    mockAuthClient.organization.create.mockResolvedValue({
      data: null,
      error: { message: "Name already taken" },
    });
    render(<OnboardingPage />);

    await fillAndSubmit("Acme Corp");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Name already taken");
    expect(mockAuthClient.organization.setActive).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});

describe("Onboarding — organization.setActive fails", () => {
  it("renders the error and does not navigate, even though the organization was created", async () => {
    mockAuthClient.organization.create.mockResolvedValue({
      data: { id: "org-1" },
      error: null,
    });
    mockAuthClient.organization.setActive.mockResolvedValue({
      data: null,
      error: { message: "Could not activate organization" },
    });
    render(<OnboardingPage />);

    await fillAndSubmit("Acme Corp");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not activate organization");
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});

describe("Onboarding — a second click", () => {
  it("creates exactly one organization when the button is clicked twice in a row", async () => {
    // Two rows is not a cosmetic duplicate: `setActive` picks one, and the
    // other becomes an organization the person owns with no screen anywhere to
    // see it, switch to it, or delete it.
    let finishCreate!: (value: { data: { id: string }; error: null }) => void;
    mockAuthClient.organization.create.mockReturnValue(
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
    );
    mockAuthClient.organization.setActive.mockResolvedValue({ data: {}, error: null });
    render(<OnboardingPage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.Onboarding.orgName), "Acme Corp");
    const button = screen.getByRole("button", { name: en.Onboarding.create });
    await user.click(button);

    expect(button).toBeDisabled();
    await user.click(button);
    await user.dblClick(button);

    expect(mockAuthClient.organization.create).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishCreate({ data: { id: "org-1" }, error: null });
    });
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/brands"));
    expect(mockAuthClient.organization.create).toHaveBeenCalledTimes(1);
  });

  it("lets the person try again after a failure — the guard closes the window, it does not lock the screen", async () => {
    mockAuthClient.organization.create.mockResolvedValue({
      data: null,
      error: { message: "Name already taken" },
    });
    render(<OnboardingPage />);

    await fillAndSubmit("Acme Corp");

    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: en.Onboarding.create })).not.toBeDisabled();
  });

  it("stays disabled after success, so the window cannot reopen during the route change", async () => {
    mockAuthClient.organization.create.mockResolvedValue({ data: { id: "org-1" }, error: null });
    mockAuthClient.organization.setActive.mockResolvedValue({ data: {}, error: null });
    render(<OnboardingPage />);

    await fillAndSubmit("Acme Corp");

    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/brands"));
    expect(screen.getByRole("button", { name: en.Onboarding.create })).toBeDisabled();
  });
});
