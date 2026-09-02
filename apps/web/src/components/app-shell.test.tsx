import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authClient,
  pendingSession,
  sessionRefetch,
  signedInSession,
} from "@/test/auth-client.stub";
import { navigationState, routerMock } from "@/test/next-navigation.stub";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../messages/en.json";
import { AppShell } from "./app-shell";

describe("AppShell navigation", () => {
  // The shell renders nothing at all without a session now — it is the auth
  // guard for every route under it — so the chrome tests have to say who is
  // looking at it. That is the point of the guard, not an inconvenience.
  beforeEach(() => {
    signedInSession();
  });

  it("renders Queue, Brands and Settings with the right hrefs, Settings last", () => {
    render(<AppShell title="Queue">content</AppShell>);

    const nav = screen.getByRole("navigation", { name: en.Nav.label });
    const links = within(nav).getAllByRole("link");

    // Order matters: the constitution requires Queue, Brands, [spacer],
    // Settings LAST — proved here by the exact href sequence, not just set
    // membership.
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/en/content",
      "/en/brands",
      "/en/settings",
    ]);
  });

  it("gives every nav destination its translated accessible name", () => {
    render(<AppShell title="Queue">content</AppShell>);

    const nav = screen.getByRole("navigation", { name: en.Nav.label });
    expect(within(nav).getByRole("link", { name: en.Nav.queue })).toHaveAttribute(
      "href",
      "/en/content",
    );
    expect(within(nav).getByRole("link", { name: en.Nav.brands })).toHaveAttribute(
      "href",
      "/en/brands",
    );
    expect(within(nav).getByRole("link", { name: en.Nav.settings })).toHaveAttribute(
      "href",
      "/en/settings",
    );
  });

  it("marks only the destination matching the current pathname as active", () => {
    navigationState.pathname = "/en/brands";
    render(<AppShell title="Brands">content</AppShell>);

    const nav = screen.getByRole("navigation", { name: en.Nav.label });
    expect(within(nav).getByRole("link", { name: en.Nav.brands })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: en.Nav.queue })).not.toHaveAttribute(
      "aria-current",
    );
    expect(within(nav).getByRole("link", { name: en.Nav.settings })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("treats a sub-route (e.g. /en/content/42) as still under its section", () => {
    navigationState.pathname = "/en/content/42";
    render(<AppShell title="Item">content</AppShell>);

    const nav = screen.getByRole("navigation", { name: en.Nav.label });
    expect(within(nav).getByRole("link", { name: en.Nav.queue })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders the page title and the children passed to it", () => {
    render(<AppShell title="My Title">the page body</AppShell>);

    expect(screen.getByRole("heading", { level: 1, name: "My Title" })).toBeInTheDocument();
    expect(screen.getByText("the page body")).toBeInTheDocument();
  });
});

describe("AppShell auth guard", () => {
  it("renders nothing and sends a signed-out visitor to login, carrying the page they wanted", async () => {
    // No signedInSession() here — the aliased stub's default is signed out,
    // which is exactly the state the shell must refuse to paint. Before the
    // guard existed this rendered the whole screen (nav, title, the page's own
    // body) to someone with no session.
    navigationState.pathname = "/en/settings";
    render(<AppShell title="Settings">the organization's API keys</AppShell>);

    expect(screen.queryByRole("navigation", { name: en.Nav.label })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText("the organization's API keys")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith("/en/login?next=%2Fen%2Fsettings"),
    );
  });

  it("does not mistake a session that is still loading for a signed-out one", async () => {
    // The first render of every page looks like this. Redirecting here would
    // bounce a perfectly signed-in user to the login screen on every cold load.
    pendingSession();
    render(<AppShell title="Queue">content</AppShell>);

    expect(screen.queryByText("content")).not.toBeInTheDocument();
    await Promise.resolve();
    expect(sessionRefetch).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("asks the server before bouncing anyone", async () => {
    render(<AppShell title="Queue">content</AppShell>);

    await waitFor(() => expect(sessionRefetch).toHaveBeenCalledTimes(1));
  });

  it("does not bounce a visitor whose session the server confirms after all", async () => {
    // The browser race this guard exists for: better-auth's session store is a
    // module-level singleton, and the `null` it settled on while the login
    // screen was open outlives the sign-in by a tick. Judging it directly sent
    // someone who had just logged in back to the login screen.
    sessionRefetch.mockImplementation(async () => {
      signedInSession("ann@example.com");
    });
    render(<AppShell title="Queue">content</AppShell>);

    expect(await screen.findByText("content")).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("asks only once, however many times the effect is invoked", async () => {
    // React StrictMode invokes every effect twice on mount; a guard that asked
    // per invocation would double every signed-out visit's traffic.
    const { rerender } = render(<AppShell title="Queue">content</AppShell>);
    rerender(<AppShell title="Queue">content</AppShell>);

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
    expect(sessionRefetch).toHaveBeenCalledTimes(1);
  });

  it("renders the page and redirects nowhere for a signed-in visitor", () => {
    signedInSession("ann@example.com");
    render(<AppShell title="Queue">content</AppShell>);

    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getByText("ann@example.com")).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});

describe("AppShell user menu", () => {
  beforeEach(() => {
    signedInSession("ann@example.com");
    authClient.signOut.mockReset();
    authClient.signOut.mockResolvedValue(undefined);
  });

  it("signs out AND leaves — the menu item is not a no-op that keeps you on the page", async () => {
    render(<AppShell title="Queue">content</AppShell>);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "ann@example.com" }));
    await user.click(screen.getByRole("menuitem", { name: en.Landing.signOut }));

    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/en/login"));
  });
});
