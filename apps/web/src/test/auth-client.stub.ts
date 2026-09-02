import { useSyncExternalStore } from "react";
import { vi } from "vitest";

/**
 * Default `@/lib/auth-client` stand-in, aliased in vitest.config.ts exactly
 * like `next/navigation`. AppShell calls `authClient.useSession()` on every
 * authed page, so every page test needs *some* answer for it — without this,
 * the real better-auth client would fire a real `fetch` from jsdom on every
 * render, which is slow at best and an unhandled rejection at worst.
 *
 * The default is SIGNED OUT (`data: null`) — not a fabricated user. A stub
 * that defaults to "happy path signed in" is exactly the silent-green trap
 * this repo hunts: a future AppShell-wrapped page test that forgets to opt
 * in would otherwise render real user-block content by accident and never
 * notice it wasn't testing what it thought it was. A test that actually
 * needs a session says so explicitly via `signedInSession()` /
 * `signedInOrganization()` — one visible line, not an ambient default.
 *
 * `resetStubSession()` is wired into the global `afterEach` (`setup.ts`),
 * same as `resetNavigation()` for the navigation stub, so an opt-in in one
 * test never leaks into the next.
 *
 * Tests that care about the session/organization/sign-out behaviour itself
 * (AppShell's probe test, Settings, Landing, AuthForm) still do their own
 * `vi.mock("@/lib/auth-client", ...)`, which fully replaces this module —
 * the alias only fills in for tests that don't.
 */
type SessionState = {
  data: { user: { id: string; email: string } } | null;
  isPending: boolean;
  refetch: () => Promise<void>;
};
type OrgState = { data: { id: string; name: string } | null; isPending: boolean };

/**
 * The real `useSession()` hands back a `refetch` that re-asks the server and
 * only resolves once the store holds the answer — AppShell's guard uses it to
 * confirm a suspected sign-out. One shared identity across every state below,
 * because it is an effect dependency there: a fresh function per render would
 * re-run that effect forever.
 */
export const sessionRefetch = vi.fn(async (): Promise<void> => {});

const SIGNED_OUT: SessionState = { data: null, isPending: false, refetch: sessionRefetch };
const NO_ORG: OrgState = { data: null, isPending: false };

let sessionState: SessionState = SIGNED_OUT;
let orgState: OrgState = NO_ORG;

/**
 * The real `useSession()` is a subscription to a store: writing to that store
 * — which `refetch()` does, with the server's answer — re-renders everything
 * reading it. A stub that merely returns a module variable is a *snapshot*,
 * and under it a session that dies mid-render is invisible to the component
 * until something else happens to re-render it. That is not a smaller version
 * of the real thing, it is the one behaviour the guard is built on, so the
 * stub subscribes properly and the setters below notify.
 */
const subscribers = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);
  return () => {
    subscribers.delete(onStoreChange);
  };
}

function setSessionState(next: SessionState): SessionState {
  sessionState = next;
  for (const notify of [...subscribers]) notify();
  return next;
}

export const authClient = {
  useSession: vi.fn(() =>
    useSyncExternalStore(
      subscribe,
      () => sessionState,
      () => sessionState,
    ),
  ),
  useActiveOrganization: vi.fn(() => orgState),
  signOut: vi.fn(),
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
  organization: { create: vi.fn(), setActive: vi.fn() },
};

/** Opt-in: `authClient.useSession()` reports a signed-in user until reset. */
export function signedInSession(email = "test@example.com"): SessionState {
  return setSessionState({
    data: { user: { id: "test-user", email } },
    isPending: false,
    refetch: sessionRefetch,
  });
}

/**
 * Opt-in: the session ends. Not the same as the default — this is the store
 * *changing* to null under a mounted component, which is what a `refetch()`
 * that finds the session gone actually does.
 */
export function signedOutSession(): SessionState {
  return setSessionState(SIGNED_OUT);
}

/**
 * Opt-in: the session is still loading — the state every real page starts in.
 * AppShell's guard must NOT read this as signed out, so it needs saying.
 */
export function pendingSession(): SessionState {
  return setSessionState({ data: null, isPending: true, refetch: sessionRefetch });
}

/** Opt-in: `authClient.useActiveOrganization()` reports an org until reset. */
export function signedInOrganization(name = "Test Org"): OrgState {
  orgState = { data: { id: "test-org", name }, isPending: false };
  return orgState;
}

/** Back to the safe signed-out default. Called from `setup.ts`'s afterEach. */
export function resetStubSession(): void {
  setSessionState(SIGNED_OUT);
  orgState = NO_ORG;
  sessionRefetch.mockReset();
}
