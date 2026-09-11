import { checkBrowserOrigin, originMismatchBody } from "@pubrick/shared";
import type { BetterAuthPlugin } from "better-auth";

/**
 * The context better-auth hands `onRequest`, taken from the hook's own type
 * rather than imported from `@better-auth/core` — which is a transitive
 * dependency here, not a declared one, and compiles under vitest's resolver
 * while `nest build` refuses it.
 */
export type AuthRequestContext = Parameters<NonNullable<BetterAuthPlugin["onRequest"]>>[1];

/**
 * The first-run refusal that names both origins.
 *
 * WHY A PLUGIN `onRequest`, AND NOT THE TWO OBVIOUS PLACES.
 *
 * - NOT a `hooks.before` like `auth-signup-gate.ts`. better-auth registers its
 *   own `originCheckMiddleware` as a router middleware at `/**`, ahead of every
 *   hook a config can add (`better-auth/dist/api/index.mjs`, `router()`), so a
 *   hook here would only ever see requests the origin check had already let
 *   through — never the one this exists for.
 * - NOT a Nest middleware. Measured, not assumed: mounted through
 *   `MiddlewareConsumer` on `AppModule` it never ran at all, and every auth
 *   request still came back with better-auth's `INVALID_ORIGIN` — `AuthModule`
 *   mounts the auth handler from an imported module, and Nest applies that one
 *   first. A plugin's `onRequest` is the auth router's first step after the
 *   rate limiter, which is the property this needs.
 *
 * No path test: `onRequest` is only ever handed requests already routed to the
 * auth handler, and a redundant predicate here is a line that can silently stop
 * matching and disable the guard.
 *
 * WHAT IT DOES NOT DO. It is not a second origin check, and it makes nothing
 * stricter. It refuses exactly the requests better-auth was going to refuse
 * anyway — with a sentence naming the variable to change instead of
 * `Invalid origin`, which names neither value — and everything it cannot judge
 * (no `Origin` header, a header that does not parse) it hands straight to
 * better-auth's own check, which stays the boundary. `deploy-origin.ts` has the
 * reasoning for why `Origin` is the only header a proxied deployment lets us
 * compare.
 *
 * WHICH IS WHY THE ALLOW-LIST IS BETTER-AUTH'S OWN, read off `ctx` rather than
 * re-derived from `WEB_ORIGIN`. Comparing that one value made the claim above
 * false: better-auth also trusts `new URL(BETTER_AUTH_URL).origin`, every entry
 * of `trustedOrigins`, and `BETTER_AUTH_TRUSTED_ORIGINS` from the environment —
 * so an operator who declared a second trusted origin got a hard 403 telling
 * them to change `PUBLIC_ORIGIN`, on a request better-auth would have accepted
 * and about a variable that was not their problem. See `acceptedOrigins` below.
 */
export function originMismatchPlugin(configuredOrigin: string): BetterAuthPlugin {
  return {
    id: "pubrick-origin-mismatch",
    async onRequest(request: Request, ctx: AuthRequestContext) {
      const browserOrigin = request.headers.get("origin");
      const accepted = acceptedOrigins(ctx);
      if (accepted === null) return;
      const verdict = checkBrowserOrigin(browserOrigin, configuredOrigin, accepted);
      if (verdict.kind !== "mismatch") return;
      // The patterns this module does not parse — `*.web.example`, a custom
      // scheme — asked of the only code that owns them. Reached only for an
      // origin already refused above, so it can widen the allow-list back to
      // better-auth's and never narrow it.
      if (browserOrigin !== null && isTrustedByBetterAuth(ctx, browserOrigin)) return;
      return {
        response: Response.json(
          originMismatchBody(
            verdict.browserOrigin,
            verdict.configuredOrigin,
            verdict.acceptedOrigins,
          ),
          { status: 403 },
        ),
      };
    },
  };
}

/**
 * better-auth's live allow-list, or `null` when this cannot know it.
 *
 * `ctx.trustedOrigins` is the list better-auth's own `validateOrigin` compares
 * against (`api/middlewares/origin-check.mjs`), computed once per instance from
 * `BETTER_AUTH_URL`, `trustedOrigins` and the `BETTER_AUTH_TRUSTED_ORIGINS`
 * environment variable (`context/helpers.mjs` → `create-context.mjs`). Reading
 * it here rather than re-deriving it is the whole fix: two lists cannot drift
 * apart when there is one list.
 *
 * `null` for the one shape better-auth resolves per request — `trustedOrigins`
 * as a FUNCTION, whose result `validateOrigin` awaits and adds to the set, and
 * which is in neither `ctx.trustedOrigins` nor `ctx.isTrustedOrigin`. This
 * install does not use that form, but an install that did would have origins
 * this hook cannot see, and refusing one of them ahead of the boundary is
 * exactly the bug being fixed. Silence there is the honest answer: better-auth
 * still refuses what it always refused, in its own words.
 */
function acceptedOrigins(ctx: AuthRequestContext): string[] | null {
  if (typeof ctx?.options?.trustedOrigins === "function") return null;
  return ctx?.trustedOrigins ?? [];
}

/** better-auth's own predicate, for the patterns this module does not parse. */
function isTrustedByBetterAuth(ctx: AuthRequestContext, browserOrigin: string): boolean {
  return typeof ctx?.isTrustedOrigin === "function" && ctx.isTrustedOrigin(browserOrigin);
}
