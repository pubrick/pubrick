import type { BetterAuthPlugin } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { hostedIdentityPlugin } from "./auth-hosted.plugin";

type HookContext = Parameters<
  NonNullable<NonNullable<BetterAuthPlugin["hooks"]>["after"]>[number]["handler"]
>[0];
function context(path: string, returned: unknown) {
  const json = vi.fn((value: unknown) => value);
  return { path, context: { returned }, json } as unknown as HookContext;
}
describe("hosted session read policy", () => {
  it("sanitizes an unverified getSession return rather than passing old ownership cookies to Nest", async () => {
    const plugin = hostedIdentityPlugin(true, true);
    const hook = plugin.hooks?.after?.[0];
    expect(hook).toBeDefined();
    const request = context("/get-session", {
      user: { id: "old-user", emailVerified: false },
      session: { token: "old-session" },
    });
    expect(hook?.matcher(request)).toBe(true);
    expect(await hook?.handler(request)).toBeNull();
  });
  it("preserves verified users and the unchanged self-hosted session policy", async () => {
    const hosted = hostedIdentityPlugin(true, true).hooks?.after?.[0];
    const request = context("/get-session", {
      user: { emailVerified: true },
      session: { token: "verified" },
    });
    expect(await hosted?.handler(request)).toBeUndefined();
    expect(hostedIdentityPlugin(false, false).hooks?.after?.[0]?.matcher(request)).toBe(false);
  });
});
