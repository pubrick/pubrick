import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import {
  authClient,
  pendingSession,
  sessionRefetch,
  signedInSession,
  signedOutSession,
} from "@/test/auth-client.stub";
import { navigationState, routerMock } from "@/test/next-navigation.stub";
import { act, render, screen, waitFor, within } from "@/test/render";
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

/**
 * The seam two correct commits made between them.
 *
 * One made this shell the auth guard for everything under it, redirecting the
 * moment the session store resolves to null. A later one gave two screens a
 * poll that runs while a delivery is in flight. Nothing joined them: a 401
 * from the API is not something better-auth is ever told about, its store
 * refreshes only on tab-visibility and network-online events, and the reader
 * this polling exists for is *watching the tab* — so neither fires. The poll
 * stopped on the 4xx, the alert went red, and the screen stayed exactly where
 * it was, with no redirect and no link out of it, until the person left the
 * tab and came back.
 *
 * These tests drive the real `api()` (not the page tests' `vi.mock`) through a
 * real `usePoll`, because the whole finding lives in the wiring between them.
 * The screen renders the shell from the SAME component that polls — which is
 * how every screen in this app is built, and why the guard alone could never
 * have caught this.
 */
describe("AppShell when the session dies under a poll", () => {
  const never = () => false;
  const fetchThing = () => api<{ ok: boolean }>("/api/content");

  function PollingScreen() {
    const { error } = usePoll(fetchThing, never);
    return (
      <AppShell title="Queue">
        {error instanceof Error ? <p role="alert">{error.message}</p> : "the queue"}
      </AppShell>
    );
  }

  const fetchOther = () => api<{ ok: boolean }>("/api/runs?state=open");

  /** The queue's shape: one component, two polls, one shell. */
  function TwoPollScreen() {
    const first = usePoll(fetchThing, never);
    const second = usePoll(fetchOther, never);
    return (
      <AppShell title="Queue">
        {first.error instanceof Error || second.error instanceof Error ? "failed" : "the queue"}
      </AppShell>
    );
  }

  function respondWith(status: number, message: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: status >= 200 && status < 300,
            status,
            statusText: "",
            text: async () => JSON.stringify({ statusCode: status, message }),
            json: async () => ({ ok: true }),
          }) as Response,
      ),
    );
  }

  beforeEach(() => {
    signedInSession();
    navigationState.pathname = "/en/content";
  });

  it("sends the reader to login, carrying the screen they were watching", async () => {
    respondWith(401, "You're signed out. Log in again to continue.");

    render(<PollingScreen />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith("/en/login?next=%2Fen%2Fcontent"),
    );
  });

  it("takes the dead screen down rather than leaving a red sentence on it", async () => {
    respondWith(401, "You're signed out. Log in again to continue.");

    render(<PollingScreen />);

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: en.Nav.label })).not.toBeInTheDocument();
  });

  it("tells the session store too, so the rest of the app stops believing in it", async () => {
    // The store is what every other screen reads. Leaving it holding a session
    // the server has already refused is how the login screen we just navigated
    // to would decide the visitor is signed in.
    respondWith(401, "You're signed out. Log in again to continue.");

    render(<PollingScreen />);

    await waitFor(() => expect(sessionRefetch).toHaveBeenCalled());
  });

  it("does not re-ask a question the server has already answered", async () => {
    // The store catches up a moment later and settles on null — which is the
    // ordinary suspected-sign-out the guard confirms with a round trip before
    // acting on. Not here: a 401 IS the server's answer, so a second
    // `get-session` would buy nothing, and a second navigation to the same
    // href even less.
    respondWith(401, "You're signed out. Log in again to continue.");
    sessionRefetch.mockImplementation(async () => {
      signedOutSession();
    });

    render(<PollingScreen />);

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
    await act(async () => {});
    expect(sessionRefetch).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
  });

  it("leaves once when both of the queue's polls fail together", async () => {
    // The shape of the real screen: the queue polls its cards AND its open
    // runs, and one dead session fails both, in the same tick. One event, one
    // departure — two navigations to the same href and two `get-session`
    // round trips would be the same fix firing twice. StrictMode on top, since
    // it invokes the subscribing effect twice on mount.
    respondWith(401, "You're signed out. Log in again to continue.");

    render(
      <StrictMode>
        <TwoPollScreen />
      </StrictMode>,
    );

    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
    await act(async () => {});
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    expect(sessionRefetch).toHaveBeenCalledTimes(1);
  });

  it("leaves a signed-in reader alone when the failure is the server's, not the session's", async () => {
    // A 5xx and a dropped connection are blips; `usePoll` keeps going and the
    // screen keeps its alert. Bouncing anyone here would log people out over a
    // restarting API.
    respondWith(500, "Internal Server Error");

    render(<PollingScreen />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("leaves a signed-in reader alone on a 403 — that is a permission, not a session", async () => {
    respondWith(403, "You don't have access to this.");

    render(<PollingScreen />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});
