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
// Better Auth 1.7.1 has one pathless server-only organization writer:
// addMember dispatches operationId=addOrganizationMember before its endpoint handler.
const allowedOrganizationPaths = new Set([
  "/organization/check-slug",
  "/organization/update", // Name/slug metadata only; SDK still enforces its manager policy.
  "/organization/get-organization",
  "/organization/get-full-organization",
  "/organization/set-active",
  "/organization/list",
  "/organization/get-active-member",
  "/organization/get-active-member-role",
  "/organization/list-members",
  "/organization/get-invitation",
  "/organization/list-invitations",
  "/organization/list-user-invitations",
  "/organization/list-teams",
  "/organization/list-user-teams",
  "/organization/list-team-members",
  "/organization/list-roles",
  "/organization/get-role",
]);
/** Unknown organization writers remain closed when the SDK adds an endpoint. */
export function isRawOrganizationMutation(
  path: string | undefined,
  operationId?: unknown,
): boolean {
  return (
    operationId === "addOrganizationMember" ||
    (!!path?.startsWith("/organization/") && !allowedOrganizationPaths.has(path))
  );
}
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
        {
          matcher: (ctx) =>
            hosted &&
            billing.enabled &&
            isRawOrganizationMutation(ctx.path, "operationId" in ctx ? ctx.operationId : undefined),
          handler: createAuthMiddleware(async () => {
            throw new APIError("FORBIDDEN", {
              code: "HOSTED_ORGANIZATION_MUTATION_REQUIRED",
              message: "Use Pubrick workspace actions for this operation.",
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
