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
type SessionState = { data: { user: { id: string; email: string } } | null; isPending: boolean };
type OrgState = { data: { id: string; name: string } | null; isPending: boolean };

const SIGNED_OUT: SessionState = { data: null, isPending: false };
const NO_ORG: OrgState = { data: null, isPending: false };

let sessionState: SessionState = SIGNED_OUT;
let orgState: OrgState = NO_ORG;

export const authClient = {
  useSession: vi.fn(() => sessionState),
  useActiveOrganization: vi.fn(() => orgState),
  signOut: vi.fn(),
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
  organization: { create: vi.fn(), setActive: vi.fn() },
};

/** Opt-in: `authClient.useSession()` reports a signed-in user until reset. */
export function signedInSession(email = "test@example.com"): SessionState {
  sessionState = { data: { user: { id: "test-user", email } }, isPending: false };
  return sessionState;
}

/** Opt-in: `authClient.useActiveOrganization()` reports an org until reset. */
export function signedInOrganization(name = "Test Org"): OrgState {
  orgState = { data: { id: "test-org", name }, isPending: false };
  return orgState;
}

/** Back to the safe signed-out default. Called from `setup.ts`'s afterEach. */
export function resetStubSession(): void {
  sessionState = SIGNED_OUT;
  orgState = NO_ORG;
}
