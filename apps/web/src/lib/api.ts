export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 403 raised by ActiveOrgGuard because the session has no active organization. */
    readonly noActiveOrg = false,
  ) {
    super(message);
  }
}

/**
 * What to actually show the user for a failed request.
 *
 * A 4xx is the server saying something specific and actionable about THIS
 * request — "Approved content cannot be edited; reject it first", "This
 * content has already been published", "No active organization" — and the
 * whole value of it is the detail. Collapsing that into a generic apology
 * throws away the only thing that tells the operator what to do next, so a
 * 4xx message is rendered as it came.
 *
 * A 5xx, or a failure with no HTTP status at all (network down, DNS, a proxy's
 * own error page), says nothing the user can act on and was never written for
 * them. Those collapse into the caller's translated fallback, which is the
 * point of the per-screen `genericError` keys. A network failure that never
 * reached the server is wrapped as `ApiError(0, ...)` (see `api()` below) and
 * must land here too — hence the lower bound, not just `< 500`.
 */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 ? err.message : fallback;
}

/** Nest error bodies are `{ statusCode, message, error }`; message may be a string[]. */
function serverMessage(raw: string): string | undefined {
  try {
    const body = JSON.parse(raw) as { message?: unknown };
    if (typeof body.message === "string" && body.message.length > 0) return body.message;
    if (Array.isArray(body.message) && body.message.length > 0) return body.message.join(", ");
  } catch {
    // Not JSON (proxy error page, gateway timeout) — never surface the raw body.
  }
  return undefined;
}

/**
 * One request, one error contract — everything except reading the body.
 *
 * Split out of `api()` so that a response with NO body (a 204) can be issued
 * through exactly the same failure handling instead of a bespoke `fetch` at the
 * call site. Both wrappers below therefore reject with an `ApiError` and
 * nothing else, which is what every screen's `handleError` assumes.
 */
async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (err) {
    // fetch() itself rejected: network down, DNS, CORS, an aborted request —
    // the request never got an HTTP status at all. Wrapping it keeps every
    // caller's failure handling to one shape (catch ApiError, call
    // errorMessage()) instead of every call site needing its own branch for
    // "the promise rejected with something that isn't an ApiError".
    throw new ApiError(0, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    const raw = await res.text();
    const detail = serverMessage(raw);
    if (res.status === 401) {
      // Deliberately NOT "your session has expired". A 401 says only that the
      // request carried no valid session — which is equally true of a session
      // that timed out, one revoked elsewhere, and one the person ended by
      // pressing Sign out a second ago. better-auth gives the browser no way
      // to tell those apart (`useSession` reports every one of them as
      // `data: null`), and the old sentence told a user who had just signed
      // out that something had gone wrong. "Signed out" is the one claim true
      // in every case; AppShell's guard is what supplies the way back.
      throw new ApiError(401, "You're signed out. Log in again to continue.");
    }
    if (res.status === 403) {
      const noActiveOrg = /no active organization/i.test(detail ?? "");
      throw new ApiError(
        403,
        noActiveOrg
          ? "No active organization — create or select one first."
          : "You don't have access to this.",
        noActiveOrg,
      );
    }
    throw new ApiError(res.status, detail ?? res.statusText ?? `Request failed (${res.status})`);
  }
  return res;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init);
  return (await res.json()) as T;
}

/**
 * A request whose response carries no body.
 *
 * `POST /api/content/:id/opened` answers 204 by design — there is nothing to
 * say back, and nothing for a client to have to parse — and `res.json()` on an
 * empty body throws a raw `SyntaxError`, which is neither an `ApiError` nor
 * anything `errorMessage` can translate. That is a property of the endpoint,
 * not of one call site, so it is handled here rather than by a `.catch(() => {})`
 * wrapped around one caller: the next 204 endpoint gets the same treatment for
 * free instead of rediscovering the same crash.
 */
export async function apiVoid(path: string, init?: RequestInit): Promise<void> {
  await request(path, init);
}
