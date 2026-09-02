/**
 * Deployment posture for the auth surface: who may register, whose forwarded IP we
 * believe, and which secrets are too well known to boot production with.
 *
 * Everything here is a pure function over strings — no database, no network, no
 * `process.env` reads. These are the decisions that make a public install safe, so
 * they are testable in isolation; `auth.ts`, `auth-signup-gate.ts` and `env.ts` are
 * the call sites that feed them real values.
 */

/** What the instance actually does with a sign-up attempt. */
export type SignupPosture = "open" | "invite" | "closed";

/**
 * What the operator asked for. `auto` is the unset default: open until the instance
 * has its first account, invite-only from then on.
 */
export type SignupMode = SignupPosture | "auto";

/** Accepted values of `SIGNUP_MODE`, in the order the docs list them. */
export const SIGNUP_MODES: readonly SignupMode[] = ["open", "invite", "closed", "auto"];

/**
 * Reads `SIGNUP_MODE`. Unset or empty means `auto`; anything unrecognised throws
 * rather than silently degrading — a typo like `SIGNUP_MODE=invite-only` must not
 * quietly leave registration open.
 */
export function parseSignupMode(raw: string | undefined | null): SignupMode {
  const value = (raw ?? "").trim();
  if (value === "") return "auto";
  if ((SIGNUP_MODES as readonly string[]).includes(value)) return value as SignupMode;
  throw new Error(
    `Invalid SIGNUP_MODE "${value}". Expected one of: ${SIGNUP_MODES.join(", ")} (or unset for auto).`,
  );
}

/**
 * Turns the operator's mode into the posture for this request.
 *
 * `auto` is resolved against the instance rather than against a variable, because a
 * self-hosted install has to let its very first account in with no configuration at
 * all, and must close the door immediately afterwards. The window is exactly one
 * account wide and closes without anyone remembering to flip a setting back — which
 * is the failure mode of the alternative (`SIGNUP_MODE=open`, register, unset it).
 */
export function resolveSignupPosture(mode: SignupMode, instanceHasUsers: boolean): SignupPosture {
  if (mode !== "auto") return mode;
  return instanceHasUsers ? "invite" : "open";
}

/**
 * The one answer a refused sign-up ever gives.
 *
 * Better Auth's own sign-up replies `USER_ALREADY_EXISTS` for a registered address and
 * 200 for a fresh one, which turns the endpoint into an address oracle. The gate runs
 * *before* that endpoint, so on a closed or uninvited instance every address —
 * registered or not — gets this identical 403 and nothing is confirmed.
 *
 * It lives here, in the module with no database import, so a spec can assert on it
 * without dragging the api's env parsing into its own module graph.
 */
export const SIGNUP_DISABLED_MESSAGE =
  "Registration is not open on this instance. Ask an administrator for an invitation.";

/** Error code clients can branch on without parsing the message. */
export const SIGNUP_DISABLED_CODE = "SIGNUP_DISABLED";

/**
 * Parses `TRUSTED_PROXIES` — a comma-separated list of IPs/CIDR ranges of the hops
 * between the internet and this api. Empty means "believe no forwarded header",
 * which is the safe default: an undeclared deployment cannot tell a real
 * `X-Forwarded-For` from one the caller typed.
 */
export function parseTrustedProxies(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Which headers better-auth may read a client IP from.
 *
 * The web app proxies `/api` through a Next rewrite, and Next only *fills in*
 * `x-forwarded-for` when the caller did not send one (`req.headers['x-forwarded-for']
 * ??= socket.remoteAddress` — next 16.3.2, server/base-server.js). So a caller's own
 * header arrives at the api verbatim, and with no declared proxy every request can
 * pick its own rate-limit bucket and its own recorded session address. Reading no
 * header at all is worse for forensics and better for safety: better-auth then keys
 * one shared per-path bucket instead of a per-attacker one.
 */
export function ipAddressHeadersFor(trustedProxies: readonly string[]): string[] {
  return trustedProxies.length > 0 ? ["x-forwarded-for"] : [];
}

/**
 * Secret values published in this repository — init.sh's dev fallbacks and
 * .env.example's placeholders. A value that is in git is not a secret: an install
 * that boots with one of these has a forgeable session cookie and a decryptable
 * credential store, and nothing about it looks broken.
 *
 * `auth-deployment.spec.ts` re-derives this list from init.sh and .env.example and
 * fails if either file publishes a value that is missing here, so adding a fallback
 * to those files cannot outrun this guard.
 */
export const PUBLISHED_DEVELOPMENT_SECRETS: readonly string[] = [
  // init.sh's historical dev fallbacks (removed from it, still refused forever:
  // an existing checkout may have baked them into its own .env).
  "dev-only-secret-change-me",
  "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=",
  // .env.example placeholders, in case someone copies the file and only fills one in.
  "REPLACE_ME_RUN_openssl_rand_base64_32",
  // better-auth's own documented placeholder.
  "better-auth-secret-123456789",
];

/** Names of the secrets in `values` whose value is published in this repository. */
export function findPublishedSecrets(values: Record<string, string | undefined>): string[] {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && PUBLISHED_DEVELOPMENT_SECRETS.includes(value))
    .map(([name]) => name);
}

/**
 * Refuses to boot a production install on a published secret.
 *
 * Only enforced when `NODE_ENV` is `production`, which is what the shipped images
 * set: the dev bootstrap and the test suite legitimately run on known values.
 */
export function assertNoPublishedSecrets(
  values: Record<string, string | undefined>,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv !== "production") return;
  const offenders = findPublishedSecrets(values);
  if (offenders.length === 0) return;
  throw new Error(
    `Refusing to start: ${offenders.join(" and ")} ${offenders.length > 1 ? "are" : "is"} set to a ` +
      "value published in the Pubrick repository, so it is not a secret. Generate a fresh value " +
      "for each with `openssl rand -base64 32` and restart.",
  );
}
