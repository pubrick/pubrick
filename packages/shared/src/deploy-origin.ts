/**
 * The one comparison that tells an operator their `PUBLIC_ORIGIN` is wrong.
 *
 * THE TRAP. `PUBLIC_ORIGIN` is the origin a browser types, and compose derives
 * `BETTER_AUTH_URL` and `WEB_ORIGIN` from it — the base URL auth cookies are
 * issued for, and the only origin better-auth trusts. Nothing derives it from
 * `WEB_PORT`, and nothing checks the two agree. So the first-run shape is:
 * `WEB_PORT=3080` in `.env`, `PUBLIC_ORIGIN` left at the shipped
 * `http://localhost:3000`, the browser opened at `http://localhost:3080` — and
 * every sign-in refused with better-auth's own `Invalid origin`, a sentence
 * that names NEITHER value. `127.0.0.1` typed where the variable says
 * `localhost` does the same thing, and so does a reverse proxy terminating TLS
 * on a name the variable has never heard of. The reader sees a login form that
 * reloads.
 *
 * WHAT IS COMPARED, AND WHY IT IS THE `Origin` HEADER. The api sits behind the
 * web app's `/api` rewrite, which is itself behind whatever the operator put in
 * front of it, so by the time a request arrives its `Host` is `api:3001` and
 * bears no relation to what anybody typed. `Origin` is the one value that
 * survives every hop unchanged, because it describes the DOCUMENT that made the
 * request rather than the connection carrying it — which is exactly the fact
 * that makes a correctly proxied deployment indistinguishable from a local one
 * here, and a misconfigured one visible in both. Comparing `Host`, or
 * `X-Forwarded-Host`, would refuse a perfectly good TLS install.
 *
 * WHEN IT CANNOT TELL, IT SAYS NOTHING. A request with no `Origin` header at
 * all — curl, the MCP server, a same-origin GET, anything that is not a browser
 * doing a state-changing call — carries no evidence either way, and
 * `unverifiable` is the honest verdict: never a refusal. `Referer` is
 * deliberately NOT consulted as a fallback; it is stripped and truncated by
 * privacy settings a browser's owner chose, and a refusal built on it would
 * fire on installs that are correct. That leaves better-auth's own origin check
 * as the backstop for the cases this one passes through, which is where it
 * belongs — this module exists to REPLACE A SENTENCE, not a security boundary.
 *
 * Pure functions over strings: no env, no network, no database, so the api's auth
 * plugin and the web's login screen can both be held to the same words.
 */

/**
 * The refusal's machine-readable name.
 *
 * NOT a member of `API_ERROR_CODES`. That list is the wire contract of this
 * product's own endpoints, whose codes are nullary by rule; this is a refusal on
 * the better-auth surface, where `SIGNUP_DISABLED` already set the precedent of
 * a code that belongs to the auth routes and travels in better-auth's own error
 * body. It also carries one argument (`expectedOrigin` below), which is the
 * other reason it is not in that list: `origin` is attacker-controlled, so the
 * value the web interpolates for "what you opened" is read locally from
 * `window.location.origin`, and only the operator's own configured origin
 * travels.
 */
export const ORIGIN_MISMATCH_CODE = "ORIGIN_MISMATCH";

/** What the api answers a browser whose origin does not match `PUBLIC_ORIGIN`. */
export type OriginMismatchBody = {
  statusCode: 403;
  error: "Forbidden";
  message: string;
  code: typeof ORIGIN_MISMATCH_CODE;
  /**
   * The configured origin, normalised — the half the browser cannot know.
   *
   * `PUBLIC_ORIGIN` is public by definition (it is the address people type), so
   * naming it to an unauthenticated caller gives away nothing that opening the
   * site would not.
   */
  expectedOrigin: string;
};

export type OriginVerdict =
  | { kind: "match" }
  | { kind: "unverifiable" }
  | {
      kind: "mismatch";
      browserOrigin: string;
      configuredOrigin: string;
      /**
       * Every origin this instance accepts, normalised and de-duplicated — the
       * configured one first. Only its LENGTH reaches the reader (see
       * `originMismatchMessage`): the sentence must not claim `PUBLIC_ORIGIN` is
       * the whole allow-list when it is not, and must not read an operator's
       * internal origins out to an unauthenticated caller either.
       */
      acceptedOrigins: string[];
    };

/**
 * `scheme://host[:port]`, or null for anything that is not an absolute origin.
 *
 * `URL` does the whole normalisation: it lowercases scheme and host and drops
 * the port when it is the scheme's default, so `https://a.example:443` and
 * `https://a.example` compare equal, and a trailing path or slash on
 * `PUBLIC_ORIGIN` is ignored rather than making every request a mismatch.
 *
 * What it deliberately does NOT normalise away is `localhost` vs `127.0.0.1`.
 * Those are different origins to a browser — a cookie set for one is not sent
 * to the other — so treating them as equal here would paper over an install
 * that really is broken.
 */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.host === "") return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * Does the document that made this request come from an origin this instance
 * accepts?
 *
 * `alsoAccepted` IS THE POINT, and it is not an extra. better-auth's own
 * allow-list is `{new URL(BETTER_AUTH_URL).origin} ∪ trustedOrigins ∪
 * BETTER_AUTH_TRUSTED_ORIGINS`, and a check that compared `PUBLIC_ORIGIN` alone
 * would hard-refuse — ahead of that boundary, so the boundary never gets to
 * disagree — two configurations better-auth allows: an operator who declared a
 * second trusted origin, and an install whose `BETTER_AUTH_URL` and
 * `WEB_ORIGIN` name different origins. Both were measured returning 403 where
 * better-auth alone returned 401. The caller passes better-auth's live list
 * (`ctx.trustedOrigins`) so the two sets cannot drift apart; `configuredOrigin`
 * stays a separate argument because it is the one the SENTENCE names.
 *
 * Entries that are not absolute origins are dropped rather than guessed at:
 * better-auth matches a pattern like `*.web.example` with its own wildcard
 * rules, which this module does not reimplement — the plugin asks better-auth
 * itself about those (see `auth-origin.plugin.ts`).
 *
 * Unparseable on either side is `unverifiable`, not `mismatch`: a caller that
 * sent `Origin: null` (a sandboxed iframe, a `file://` page) has told us nothing
 * about an operator's configuration, and a configured origin this cannot parse
 * is a different bug, named at boot by `originDoctorLines`.
 */
export function checkBrowserOrigin(
  browserOrigin: string | null | undefined,
  configuredOrigin: string,
  alsoAccepted: readonly string[] = [],
): OriginVerdict {
  const actual = normalizeOrigin(browserOrigin);
  const expected = normalizeOrigin(configuredOrigin);
  if (actual === null || expected === null) return { kind: "unverifiable" };
  const accepted = [expected];
  for (const entry of alsoAccepted) {
    const normalised = normalizeOrigin(entry);
    if (normalised !== null && !accepted.includes(normalised)) accepted.push(normalised);
  }
  if (accepted.includes(actual)) return { kind: "match" };
  return {
    kind: "mismatch",
    browserOrigin: actual,
    configuredOrigin: expected,
    acceptedOrigins: accepted,
  };
}

/**
 * The sentence, naming BOTH values.
 *
 * Naming one is what better-auth already does (`Invalid origin`, plus the
 * rejected value in a server log nobody self-hosting is reading yet), and it is
 * the half that cannot be acted on: the reader can see the address bar. The
 * value they cannot see is the one in `.env`.
 *
 * English, in the body, for the network tab and for a web build too old to know
 * the code — the same division of labour every other refusal in this repository
 * uses. The reader's own language comes from `Auth.originMismatch` in the web.
 */
export function originMismatchMessage(
  browserOrigin: string,
  configuredOrigin: string,
  acceptedOrigins: readonly string[] = [configuredOrigin],
): string {
  const tail =
    "Sign-in cookies are issued for PUBLIC_ORIGIN only, so set PUBLIC_ORIGIN in .env to the " +
    `origin you type in the browser and restart — or open ${configuredOrigin} instead.`;
  // An instance that accepts several origins has an operator who wrote a
  // trusted-origins list (or an install whose BETTER_AUTH_URL disagrees with
  // WEB_ORIGIN), and to that reader "PUBLIC_ORIGIN is X" read as the whole
  // allow-list is false. The other origins are NOT listed: this body answers an
  // unauthenticated caller, and `PUBLIC_ORIGIN` is the address people type in a
  // way an internal origin somebody added by hand is not.
  if (acceptedOrigins.length > 1) {
    return (
      `You opened ${browserOrigin} but it is not one of the origins this instance accepts ` +
      `(PUBLIC_ORIGIN: ${configuredOrigin}). ${tail}`
    );
  }
  return `You opened ${browserOrigin} but PUBLIC_ORIGIN is ${configuredOrigin}. ${tail}`;
}

/** The whole 403, assembled once so the api cannot say one thing and mean another. */
export function originMismatchBody(
  browserOrigin: string,
  configuredOrigin: string,
  acceptedOrigins: readonly string[] = [configuredOrigin],
): OriginMismatchBody {
  return {
    statusCode: 403,
    error: "Forbidden",
    message: originMismatchMessage(browserOrigin, configuredOrigin, acceptedOrigins),
    code: ORIGIN_MISMATCH_CODE,
    expectedOrigin: configuredOrigin,
  };
}

/**
 * What the api prints at boot, so an operator reading `docker compose logs api`
 * can see which origin this instance will accept before anybody tries to log in.
 *
 * The cheap half of this fix, and the only half that is visible when nothing has
 * gone wrong yet. It names the variable, not just the value, because the value
 * alone ("http://localhost:3000") looks like a default rather than a decision.
 */
export function originDoctorLines(configuredOrigin: string, baseUrl: string): string[] {
  const expected = normalizeOrigin(configuredOrigin);
  const base = normalizeOrigin(baseUrl);
  if (expected === null) {
    return [
      `PUBLIC_ORIGIN is not an absolute origin: "${configuredOrigin}". ` +
        "Expected something like https://pubrick.example or http://localhost:3000 — " +
        "browser origins cannot be checked until it is.",
    ];
  }
  const lines = [
    `Browser origin: this instance accepts sign-ins from ${expected} (PUBLIC_ORIGIN). ` +
      "Open it at exactly that address — a different port, or 127.0.0.1 where this says " +
      "localhost, is a different origin and its sign-in will be refused by name.",
  ];
  if (base !== null && base !== expected) {
    lines.push(
      `BETTER_AUTH_URL is ${base} while WEB_ORIGIN is ${expected}. Compose derives both from ` +
        "PUBLIC_ORIGIN, so an install where they differ was configured by hand; auth cookies " +
        "follow BETTER_AUTH_URL and the trusted-origin check follows WEB_ORIGIN.",
    );
  }
  return lines;
}
