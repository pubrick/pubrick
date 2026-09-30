import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";

const publicPaths = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/send-verification-email",
  "/verify-email",
  "/request-password-reset",
  "/reset-password",
  "/sign-out",
  "/pubrick-capabilities",
  "/get-session",
]);
/** Protect all Better Auth mutations as well as the Nest guard's getSession API. */
export function hostedIdentityPlugin(
  hosted: boolean,
  recoveryEnabled: boolean,
  billing: { enabled: boolean; testMode: boolean } = { enabled: false, testMode: false },
): BetterAuthPlugin {
  return {
    id: "pubrick-hosted-identity",
    endpoints: {
      pubrickCapabilities: createAuthEndpoint(
        "/pubrick-capabilities",
        { method: "GET" },
        async (ctx) =>
          ctx.json({
            requiresEmailVerification: hosted,
            passwordRecoveryEnabled: recoveryEnabled,
            deploymentMode: hosted ? "hosted" : "self-hosted",
            billingEnabled: billing.enabled,
            billingTestMode: billing.enabled && billing.testMode,
          }),
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            hosted &&
            (!ctx.path || (!publicPaths.has(ctx.path) && !ctx.path.startsWith("/reset-password/"))),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
            if (session && !session.user.emailVerified)
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_NOT_VERIFIED",
                message: "Email verification is required.",
              });
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => hosted && ctx.path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            const result = ctx.context.returned;
            if (
              result &&
              typeof result === "object" &&
              "user" in result &&
              result.user &&
              typeof result.user === "object" &&
              (!("emailVerified" in result.user) || result.user.emailVerified !== true)
            )
              return ctx.json(null);
          }),
        },
      ],
    },
  };
}
