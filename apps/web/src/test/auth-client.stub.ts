import { vi } from "vitest";

/**
 * Default `@/lib/auth-client` stand-in, aliased in vitest.config.ts exactly
 * like `next/navigation`. AppShell now calls `authClient.useSession()` on
 * every authed page, so every page test needs *some* answer for it — without
 * this, the real better-auth client would fire a real `fetch` from jsdom on
 * every render, which is slow at best and an unhandled rejection at worst.
 *
 * Tests that care about the session/organization/sign-out behaviour itself
 * (AppShell, Settings, Landing, AuthForm) still do their own
 * `vi.mock("@/lib/auth-client", ...)`, which fully replaces this module —
 * the alias only fills in for tests that don't.
 */
export const authClient = {
  useSession: vi.fn(() => ({
    data: { user: { id: "test-user", email: "test@example.com" } },
    isPending: false,
  })),
  useActiveOrganization: vi.fn(() => ({
    data: { id: "test-org", name: "Test Org" },
    isPending: false,
  })),
  signOut: vi.fn(),
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
  organization: { create: vi.fn(), setActive: vi.fn() },
};
