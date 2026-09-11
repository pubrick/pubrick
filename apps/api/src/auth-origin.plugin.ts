import { checkBrowserOrigin, originMismatchBody } from "@pubrick/shared";
import type { BetterAuthPlugin } from "better-auth";

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
 */
export function originMismatchPlugin(configuredOrigin: string): BetterAuthPlugin {
  return {
    id: "pubrick-origin-mismatch",
    async onRequest(request: Request) {
      const verdict = checkBrowserOrigin(request.headers.get("origin"), configuredOrigin);
      if (verdict.kind !== "mismatch") return;
      return {
        response: Response.json(
          originMismatchBody(verdict.browserOrigin, verdict.configuredOrigin),
          { status: 403 },
        ),
      };
    },
  };
}
