import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orgSlug } from "@/lib/slug";
import { navigationState, routerMock } from "@/test/next-navigation.stub";
import { act, render, screen, waitFor } from "@/test/render";
import en from "../../../../messages/en.json";
import ru from "../../../../messages/ru.json";
import OnboardingPage from "./page";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    useSession: vi.fn(),
    organization: { create: vi.fn(), setActive: vi.fn(), acceptInvitation: vi.fn() },
  },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { ApiError, api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

// See AuthForm.test.tsx for why the real (server-inferred) client type is not
// worth reproducing here — the module is fully replaced by the mock above.
type MockAuthClient = {
  useSession: ReturnType<typeof vi.fn>;
  organization: {
    create: ReturnType<typeof vi.fn>;
    setActive: ReturnType<typeof vi.fn>;
    acceptInvitation: ReturnType<typeof vi.fn>;
  };
};
const mockAuthClient = authClient as unknown as MockAuthClient;
const mockApi = vi.mocked(api);

/** One invitation as `GET /api/org/invitations` returns it. */
const INVITATION = {
  id: "inv-1",
  organizationId: "org-9",
  organizationName: "Acme Media",
  inviterEmail: "alice@example.com",
  expiresAt: "2026-09-06T10:00:00.000Z",
};

/** The signed-in state every test below starts from unless it says otherwise. */
function signedIn() {
  mockAuthClient.useSession.mockReturnValue({
    data: { user: { id: "u1", email: "bob@example.com" } },
    isPending: false,
  });
}

beforeEach(() => {
  mockAuthClient.organization.create.mockReset();
  mockAuthClient.organization.setActive.mockReset();
  mockAuthClient.organization.acceptInvitation.mockReset();
  mockAuthClient.useSession.mockReset();
  mockApi.mockReset();
  signedIn();
  // The default arrival: nobody is expecting this account, so the screen is the
  // create-organization form every test below this line was written against.
  mockApi.mockResolvedValue([]);
  // orgSlug appends a random suffix; pin Math.random so the component's call
  // and the test's expected-value computation agree on the exact slug.
  vi.spyOn(Math, "random").mockReturnValue(0.123456789);
});

async function fillAndSubmit(orgName: string) {
  const user = userEvent.setup();
  // The field only exists once the invitation lookup has answered — the screen
  // deliberately shows nothing rather than guessing "nobody invited you".
  await user.type(await screen.findByLabelText(en.Onboarding.orgName), orgName);
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
    await user.type(await screen.findByLabelText(en.Onboarding.orgName), "Acme Corp");
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

/**
 * The invited person's half of the screen.
 *
 * The offer is looked up from the SESSION's address, not from the link, because
 * the link does not survive sign-up: `AuthForm` sends every new account to
 * `/onboarding` with no query of its own. A screen that depended on
 * `?invitation=` would therefore show "create your organization" to exactly the
 * people it was built for.
 */
describe("Onboarding — an invitation is waiting", () => {
  it("offers the organization by name, and does not show the create form", async () => {
    mockApi.mockResolvedValue([INVITATION]);
    render(<OnboardingPage />);

    expect(
      await screen.findByRole("heading", {
        name: en.Onboarding.invitedTitle.replace("{organization}", "Acme Media"),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(en.Onboarding.invitedSubtitle.replace("{inviter}", "alice@example.com")),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(en.Onboarding.orgName)).not.toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith("/api/org/invitations");
  });

  it("joins: accepts the invitation, makes it active, and navigates into the product", async () => {
    mockApi.mockResolvedValue([INVITATION]);
    mockAuthClient.organization.acceptInvitation.mockResolvedValue({ data: {}, error: null });
    mockAuthClient.organization.setActive.mockResolvedValue({ data: {}, error: null });
    render(<OnboardingPage />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Onboarding.invitedJoin }));

    await waitFor(() =>
      expect(mockAuthClient.organization.acceptInvitation).toHaveBeenCalledWith({
        invitationId: "inv-1",
      }),
    );
    // Explicit, even though accept-invitation sets it server-side: without an
    // active organization in the client's own session store every org-scoped
    // route 403s on arrival.
    await waitFor(() =>
      expect(mockAuthClient.organization.setActive).toHaveBeenCalledWith({
        organizationId: "org-9",
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith("/en/brands");
    // Never creates an organization on this path — that is the duplicate
    // workspace the whole screen exists to prevent.
    expect(mockAuthClient.organization.create).not.toHaveBeenCalled();
  });

  it("says so and stays put when the invitation is refused", async () => {
    mockApi.mockResolvedValue([INVITATION]);
    mockAuthClient.organization.acceptInvitation.mockResolvedValue({
      data: null,
      // The library's own English, which must NOT reach the reader: spent,
      // revoked and expired all mean one thing to them.
      error: { message: "Invitation not found!", code: "INVITATION_NOT_FOUND" },
    });
    render(<OnboardingPage />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Onboarding.invitedJoin }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.Onboarding.joinFailed);
    expect(alert).not.toHaveTextContent("Invitation not found!");
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("accepts once when Join is clicked twice", async () => {
    mockApi.mockResolvedValue([INVITATION]);
    let finish!: (value: { data: unknown; error: null }) => void;
    mockAuthClient.organization.acceptInvitation.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mockAuthClient.organization.setActive.mockResolvedValue({ data: {}, error: null });
    render(<OnboardingPage />);

    const user = userEvent.setup();
    const join = await screen.findByRole("button", { name: en.Onboarding.invitedJoin });
    await user.click(join);
    expect(join).toBeDisabled();
    await user.dblClick(join);
    expect(mockAuthClient.organization.acceptInvitation).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ data: {}, error: null });
    });
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith("/en/brands"));
    expect(mockAuthClient.organization.acceptInvitation).toHaveBeenCalledTimes(1);
  });

  it("still lets an invited account create a workspace of its own", async () => {
    mockApi.mockResolvedValue([INVITATION]);
    mockAuthClient.organization.create.mockResolvedValue({ data: { id: "org-1" }, error: null });
    mockAuthClient.organization.setActive.mockResolvedValue({ data: {}, error: null });
    render(<OnboardingPage />);

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: en.Onboarding.invitedCreateInstead }),
    );
    await fillAndSubmit("Acme Corp");

    await waitFor(() => expect(mockAuthClient.organization.create).toHaveBeenCalled());
  });

  // `?invitation=` picks WHICH offer, and can never conjure one: the list is the
  // session's own, so a link naming somebody else's invitation shows this
  // account only what is genuinely addressed to it.
  it("shows the invitation the link names when more than one is waiting", async () => {
    navigationState.searchParams = new URLSearchParams("invitation=inv-2");
    mockApi.mockResolvedValue([
      INVITATION,
      { ...INVITATION, id: "inv-2", organizationId: "org-8", organizationName: "Second Co" },
    ]);
    render(<OnboardingPage />);

    expect(
      await screen.findByRole("heading", {
        name: en.Onboarding.invitedTitle.replace("{organization}", "Second Co"),
      }),
    ).toBeInTheDocument();
  });

  it("shows an unknown id's account its own first invitation rather than nothing", async () => {
    navigationState.searchParams = new URLSearchParams("invitation=someone-elses");
    mockApi.mockResolvedValue([INVITATION]);
    render(<OnboardingPage />);

    expect(
      await screen.findByRole("heading", {
        name: en.Onboarding.invitedTitle.replace("{organization}", "Acme Media"),
      }),
    ).toBeInTheDocument();
  });
});

describe("Onboarding — nobody is signed in", () => {
  /**
   * The invitation link's first landing, and the hole this screen used to have:
   * it showed the create-organization form to a visitor with no session at all,
   * whose submit could only ever 401. What an invited person cannot guess — that
   * the address they register with has to be the invited one — is now the
   * sentence on the screen.
   */
  it("sends the visitor to sign-up and names the address rule, instead of a form they cannot submit", () => {
    mockAuthClient.useSession.mockReturnValue({ data: null, isPending: false });
    render(<OnboardingPage />);

    expect(screen.getByRole("heading", { name: en.Onboarding.signedOutTitle })).toBeInTheDocument();
    expect(screen.getByText(en.Onboarding.signedOutBody)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Onboarding.signedOutAction })).toHaveAttribute(
      "href",
      "/en/signup",
    );
    expect(screen.queryByLabelText(en.Onboarding.orgName)).not.toBeInTheDocument();
    // And nothing is asked of an API that would refuse the request anyway.
    expect(mockApi).not.toHaveBeenCalled();
  });

  it("shows neither the form nor the offer while the session is still loading", () => {
    mockAuthClient.useSession.mockReturnValue({ data: null, isPending: true });
    render(<OnboardingPage />);

    expect(screen.queryByLabelText(en.Onboarding.orgName)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: en.Onboarding.signedOutTitle }),
    ).not.toBeInTheDocument();
  });
});

describe("Onboarding — the invitation lookup fails", () => {
  /**
   * The form is still offered — an account with no organization needs some way
   * forward — but the failure is stated, because a person who WAS invited and is
   * being shown "create your organization" would otherwise create a second
   * workspace nobody else is in.
   *
   * Asserted in Russian, driven by a real refusal body, for the reason
   * `refusals.test.tsx` exists: a screen that renders the api's own sentence
   * looks perfectly correct to an English reader.
   */
  it("says the check failed, in the reader's language, and still offers the form", async () => {
    // Exactly what `request()` builds for an uncoded 403 (lib/api.ts): the
    // English sentence it writes for the network tab, plus the web's own
    // `forbidden` transport code — which is the only thing `errorMessage` is
    // allowed to translate from. Constructed rather than fetched because this
    // screen talks to `@/lib/api`, and that is the boundary the file mocks.
    mockApi.mockRejectedValue(
      new ApiError(403, "You don't have access to this.", false, "forbidden"),
    );
    render(<OnboardingPage />, { locale: "ru" });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ru.Errors.forbidden);
    expect(alert).not.toHaveTextContent("You don't have access to this.");
    expect(await screen.findByLabelText(ru.Onboarding.orgName)).toBeInTheDocument();
  });
});
