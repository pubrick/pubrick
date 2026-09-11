import { ORIGIN_MISMATCH_CODE } from "@pubrick/shared";
import { betterAuth } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuthRequestContext, originMismatchPlugin } from "./auth-origin.plugin";

const PUBLIC_ORIGIN = "http://localhost:3000";

/**
 * The auth config, and the ONE object both allow-lists are derived from.
 *
 * That is the point of building a real context here rather than passing
 * `{} as never`: the plugin's list and better-auth's list are the same list or
 * the tests below stop being true. A spec that invented its own literal could
 * not see the day someone adds an entry to `trustedOrigins` in `auth.ts` and
 * that origin starts being refused by the plugin, ahead of the boundary that
 * would have allowed it.
 */
type AuthConfig = {
  baseURL: string;
  trustedOrigins: string[] | ((request?: Request) => Promise<string[]>);
};

const DEFAULT_CONFIG: AuthConfig = { baseURL: PUBLIC_ORIGIN, trustedOrigins: [PUBLIC_ORIGIN] };

/** better-auth's own context, computed from `config` exactly as the api's is. */
async function contextFor(config: AuthConfig): Promise<AuthRequestContext> {
  const auth = betterAuth({
    baseURL: config.baseURL,
    // Long and random enough that better-auth does not warn; no database, so
    // this context is the trusted-origin computation and nothing else.
    secret: "origin-plugin-spec-secret-1f4c9a7e2b8d6053",
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
  });
  return (await auth.$context) as unknown as AuthRequestContext;
}

/** The plugin hook, called the way better-auth's router calls it. */
async function onRequest(
  headers: Record<string, string>,
  configuredOrigin = PUBLIC_ORIGIN,
  ctx?: AuthRequestContext,
): Promise<Response | undefined> {
  const plugin = originMismatchPlugin(configuredOrigin);
  const result = await plugin.onRequest?.(
    new Request("http://api:3001/api/auth/sign-in/email", { method: "POST", headers }),
    ctx ?? (await contextFor(DEFAULT_CONFIG)),
  );
  return result && "response" in result ? result.response : undefined;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("originMismatchPlugin", () => {
  it("refuses an auth request from another port, naming both origins", async () => {
    const response = await onRequest({ origin: "http://localhost:3080" });
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as Record<string, string>;
    expect(body.code).toBe(ORIGIN_MISMATCH_CODE);
    expect(body.expectedOrigin).toBe(PUBLIC_ORIGIN);
    expect(body.message).toContain("http://localhost:3080");
    expect(body.message).toContain(PUBLIC_ORIGIN);
    expect(body.message).toContain("PUBLIC_ORIGIN");
  });

  it("lets the configured origin through, however it is spelt", async () => {
    expect(await onRequest({ origin: "http://localhost:3000/" })).toBeUndefined();
  });

  /**
   * The deployment that must NOT be refused: TLS terminates on a name the api
   * never hears, so `Host` is the compose service and `X-Forwarded-Host` is the
   * public name — while the browser's own `Origin` IS the public name. A check
   * reading either of the first two refuses this perfectly good install; reading
   * `Origin` lets it through, which is the whole reason for that choice.
   */
  it("lets a correctly proxied request through, whatever Host says", async () => {
    expect(
      await onRequest(
        {
          origin: "https://pubrick.example",
          "x-forwarded-host": "pubrick.example",
          "x-forwarded-proto": "https",
        },
        "https://pubrick.example",
        await contextFor({
          baseURL: "https://pubrick.example",
          trustedOrigins: ["https://pubrick.example"],
        }),
      ),
    ).toBeUndefined();
  });

  // curl, the MCP server, a same-origin GET: no evidence either way. better-auth's
  // own check is still behind this one and answers those.
  it("passes a request with no Origin header through instead of refusing it", async () => {
    expect(await onRequest({})).toBeUndefined();
  });

  it("passes an unparseable Origin through rather than guessing", async () => {
    expect(await onRequest({ origin: "null" })).toBeUndefined();
  });

  it("cannot refuse anything when the configured origin is itself unusable", async () => {
    expect(await onRequest({ origin: "http://localhost:3080" }, "localhost:3000")).toBeUndefined();
  });

  /**
   * THE ALLOW-LIST IS BETTER-AUTH'S. Everything below is one property: the
   * plugin refuses a request only when better-auth was going to refuse it too.
   * Measured before this: with a second trusted origin declared, a sign-in from
   * it answered 401 (bad credentials, origin accepted) with the plugin removed
   * and 403 `ORIGIN_MISMATCH` with it installed — telling that operator to
   * change `PUBLIC_ORIGIN`, which was not their problem.
   */
  describe("the allow-list better-auth computed", () => {
    it("does not refuse a second declared trusted origin", async () => {
      const config: AuthConfig = {
        baseURL: PUBLIC_ORIGIN,
        trustedOrigins: [PUBLIC_ORIGIN, "https://second.example"],
      };
      expect(
        await onRequest(
          { origin: "https://second.example" },
          PUBLIC_ORIGIN,
          await contextFor(config),
        ),
      ).toBeUndefined();
    });

    // An upstream env var better-auth reads by itself (`context/helpers.mjs`),
    // which nothing in this repository passes to the plugin.
    it("does not refuse an origin trusted through BETTER_AUTH_TRUSTED_ORIGINS", async () => {
      vi.stubEnv("BETTER_AUTH_TRUSTED_ORIGINS", "https://second.example");
      expect(
        await onRequest(
          { origin: "https://second.example" },
          PUBLIC_ORIGIN,
          await contextFor(DEFAULT_CONFIG),
        ),
      ).toBeUndefined();
    });

    // A hand-configured install: better-auth trusts its own base URL, so this is
    // the one origin that used to work there. The doctor line at boot says the
    // two disagree; the refusal must not lock the reader out of the half that
    // answers.
    it("does not refuse the BETTER_AUTH_URL origin when it differs from WEB_ORIGIN", async () => {
      const ctx = await contextFor({
        baseURL: "http://localhost:34103",
        trustedOrigins: ["https://web.example"],
      });
      expect(
        await onRequest({ origin: "http://localhost:34103" }, "https://web.example", ctx),
      ).toBeUndefined();
    });

    // better-auth's patterns are its own (`matchesOriginPattern`), and this
    // module does not reimplement them — it asks better-auth.
    it("does not refuse an origin matching a wildcard pattern", async () => {
      const ctx = await contextFor({
        baseURL: "https://web.example",
        trustedOrigins: ["https://web.example", "*.web.example"],
      });
      expect(
        await onRequest({ origin: "https://app.web.example" }, "https://web.example", ctx),
      ).toBeUndefined();
    });

    // `trustedOrigins` as a function is resolved per request by
    // `validateOrigin`, and its result is in neither `ctx.trustedOrigins` nor
    // `ctx.isTrustedOrigin`. The set cannot be computed here, so nothing is
    // refused here: better-auth answers, in its own words, as it did before.
    it("refuses nothing when the trusted origins are computed per request", async () => {
      const ctx = await contextFor({
        baseURL: PUBLIC_ORIGIN,
        trustedOrigins: async () => ["https://second.example"],
      });
      expect(
        await onRequest({ origin: "https://evil.example" }, PUBLIC_ORIGIN, ctx),
      ).toBeUndefined();
    });

    /**
     * The pin the review asked for: BOTH lists from ONE config object. Add an
     * entry to `trustedOrigins` in `auth.ts` and this is the test that has to
     * keep passing — not a literal in a spec that never hears about it.
     */
    it("lets through every origin better-auth trusts, from the same config", async () => {
      const config: AuthConfig = {
        baseURL: "http://localhost:34103",
        trustedOrigins: [PUBLIC_ORIGIN, "https://second.example", "https://third.example"],
      };
      const ctx = await contextFor(config);
      expect(ctx.trustedOrigins.length).toBeGreaterThan(1);
      for (const origin of ctx.trustedOrigins) {
        expect(await onRequest({ origin }, PUBLIC_ORIGIN, ctx)).toBeUndefined();
      }
    });

    // …and no wider than that list: an origin in neither half is still refused,
    // with the sentence that does not claim PUBLIC_ORIGIN is the whole list.
    it("still refuses an origin no entry accepts, without claiming there is only one", async () => {
      const ctx = await contextFor({
        baseURL: PUBLIC_ORIGIN,
        trustedOrigins: [PUBLIC_ORIGIN, "https://second.example"],
      });
      const response = await onRequest({ origin: "https://evil.example" }, PUBLIC_ORIGIN, ctx);
      expect(response?.status).toBe(403);
      const body = (await response?.json()) as Record<string, string>;
      expect(body.code).toBe(ORIGIN_MISMATCH_CODE);
      expect(body.message).toContain("is not one of the origins this instance accepts");
      expect(body.message).toContain(`PUBLIC_ORIGIN: ${PUBLIC_ORIGIN}`);
      expect(body.message).not.toContain("second.example");
      expect(body.expectedOrigin).toBe(PUBLIC_ORIGIN);
    });
  });
});
