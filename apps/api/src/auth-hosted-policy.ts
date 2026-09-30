/** Instance policy is operator configuration, never workspace or request input. */
export type IdentityEnvironment = {
  PUBRICK_DEPLOYMENT_MODE: string;
  SIGNUP_MODE?: string;
  AUTH_RATE_LIMIT_ENABLED: boolean;
  WEB_ORIGIN: string;
  BETTER_AUTH_URL: string;
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  SMTP_SECURE: boolean;
  SMTP_REQUIRE_TLS: boolean;
};
export function identityConfig(env: IdentityEnvironment, nodeEnvironment?: string) {
  const hosted = env.PUBRICK_DEPLOYMENT_MODE === "hosted";
  if (hosted && (env.SIGNUP_MODE !== "open" || !env.AUTH_RATE_LIMIT_ENABLED))
    throw new Error("Hosted identity requires SIGNUP_MODE=open and auth rate limiting.");
  if (hosted) {
    const origin = new URL(env.WEB_ORIGIN);
    const authOrigin = new URL(env.BETTER_AUTH_URL);
    if (
      origin.origin !== authOrigin.origin ||
      origin.pathname !== "/" ||
      authOrigin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      authOrigin.search ||
      authOrigin.hash ||
      authOrigin.username ||
      authOrigin.password ||
      origin.username ||
      origin.password ||
      !["http:", "https:"].includes(origin.protocol)
    )
      throw new Error("Hosted auth and web origins must match.");
    if (nodeEnvironment === "production" && origin.protocol !== "https:")
      throw new Error("Hosted identity requires HTTPS in production.");
  }
  const configured = !!(env.SMTP_HOST || env.SMTP_USER || env.SMTP_PASSWORD || env.SMTP_FROM);
  if (!configured && !hosted) return { hosted, mail: null };
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM)
    throw new Error("Mail requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM.");
  const plaintextLocalTest =
    nodeEnvironment !== "production" && ["localhost", "127.0.0.1", "::1"].includes(env.SMTP_HOST);
  if (!env.SMTP_SECURE && !env.SMTP_REQUIRE_TLS && !plaintextLocalTest)
    throw new Error(
      "SMTP requires TLS; plaintext is allowed only for a local non-production test server.",
    );
  return {
    hosted,
    mail: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: env.SMTP_REQUIRE_TLS,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
      from: env.SMTP_FROM,
    },
  };
}
/** Better Auth owns signed tokens; this only narrows destination links to our app. */
export function canonicalMailUrl(raw: string, origin: string): string {
  const expected = new URL(origin).origin;
  const url = new URL(raw);
  if (
    url.origin !== expected ||
    !url.pathname.startsWith("/api/auth/") ||
    url.username ||
    url.password
  )
    throw new Error("Unsafe auth email URL.");
  const callback = url.searchParams.get("callbackURL");
  if (!callback || callback === "/")
    url.searchParams.set(
      "callbackURL",
      url.pathname.includes("reset-password") ? "/en/reset-password" : "/en/verify-email",
    );
  else if (callback) {
    const target = new URL(callback, expected);
    if (
      callback.startsWith("//") ||
      callback.startsWith("/\\") ||
      target.origin !== expected ||
      !/^\/(en|es|ru|pt)\/(verify-email|reset-password|login|onboarding)$/.test(target.pathname)
    )
      throw new Error("Unsafe auth email callback.");
  }
  return url.href;
}
