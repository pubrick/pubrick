import {
  type ApiErrorCode,
  isApiErrorCode,
  MAX_CONCURRENT_RUNS,
  MAX_REFINE_CALLS_PER_HOUR,
} from "@pubrick/shared";
import { reportUnauthorized } from "./unauthorized";

/**
 * Refusals the WEB writes, not the api.
 *
 * A 401 and a bare 403 never carried a sentence worth showing — `request()`
 * below replaces them with one of its own — so they were English in all four
 * languages for exactly the reason the api's refusals were, and they are the two
 * a person hits most often. They get codes from a separate list because they are
 * not part of the wire contract: no server sends them, and putting them in
 * `API_ERROR_CODES` would advertise a code the api can never emit.
 *
 * `no_active_organization` used to be here too, as the api's refusal read
 * through a sniff on its English sentence. `ActiveOrgGuard` now names it, so it
 * has moved to `API_ERROR_CODES` where a code the server really does send
 * belongs. The union below is unchanged by that move, which is the point: the
 * message map stays total over exactly the same set.
 */
export const TRANSPORT_ERROR_CODES = ["signed_out", "forbidden"] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** Everything `errorMessage` can translate: the wire's codes plus the web's own. */
export type ErrorCode = ApiErrorCode | TransportErrorCode;

function isErrorCode(value: string | null): value is ErrorCode {
  return (
    value !== null &&
    (isApiErrorCode(value) || (TRANSPORT_ERROR_CODES as readonly string[]).includes(value))
  );
}

export class ApiError extends Error {
  /**
   * The refusal's machine-readable code, or null when the failure carried none —
   * a 5xx, a network failure, an endpoint not yet converted, or an api older
   * than this build.
   *
   * Typed `string | null` rather than `ErrorCode | null` for the same reason
   * `Run.errorCode` is: it arrives OFF THE WIRE, and a released server can be
   * newer than a cached client. Asserting the narrow type here would only hide
   * the unknown value from `errorMessage`, which is the thing that actually
   * decides what a reader sees.
   */
  readonly code: string | null;

  constructor(
    readonly status: number,
    message: string,
    /**
     * 403 raised by ActiveOrgGuard because the session has no active
     * organization. Screens branch on it to send the reader to onboarding
     * instead of showing a sentence.
     *
     * Still the THIRD parameter and still a boolean because it predates codes
     * and several page tests construct it positionally. It is not a second,
     * disagreeable copy of `code`: with no explicit code it IS one, expanded
     * below, so the flag the screens route on and the sentence the reader gets
     * cannot come apart.
     */
    readonly noActiveOrg = false,
    code: string | null = null,
  ) {
    super(message);
    this.code = code ?? (noActiveOrg ? "no_active_organization" : null);
  }
}

/**
 * The message key for every code, in the reader's `Errors` namespace.
 *
 * TOTAL over the union, exactly as `RUN_FAILURE_KEYS` is total over
 * `RunFailure`: a code added to `API_ERROR_CODES` without a sentence here is a
 * COMPILE error, not a key path rendered at a user in four languages.
 */
const ERROR_MESSAGE_KEYS: Record<ErrorCode, string> = {
  content_not_found: "content_not_found",
  adaptation_not_found: "adaptation_not_found",
  content_pinned_approved: "content_pinned_approved",
  content_pinned_published: "content_pinned_published",
  adaptation_pinned_scheduled: "adaptation_pinned_scheduled",
  adaptation_pinned_queued: "adaptation_pinned_queued",
  adaptation_pinned_publishing: "adaptation_pinned_publishing",
  adaptation_pinned_published: "adaptation_pinned_published",
  content_already_published: "content_already_published",
  content_no_channels_left: "content_no_channels_left",
  unread_ai_draft: "unread_ai_draft",
  unread_ai_draft_open_only: "unread_ai_draft_open_only",
  schedule_in_past: "schedule_in_past",
  schedule_already_queued: "schedule_already_queued",
  schedule_already_publishing: "schedule_already_publishing",
  refine_limit_reached: "refine_limit_reached",
  refine_needs_ai_draft: "refine_needs_ai_draft",
  refine_no_credential: "refine_no_credential",
  refine_timed_out: "refine_timed_out",
  refine_failed: "refine_failed",
  refine_too_long: "refine_too_long",
  channels_not_in_brand: "channels_not_in_brand",
  channel_not_found: "channel_not_found",
  unreadable_credentials: "unreadable_credentials",
  run_not_found: "run_not_found",
  brand_not_found: "brand_not_found",
  brand_has_no_channels: "brand_has_no_channels",
  run_limit_reached: "run_limit_reached",
  run_not_cancellable_succeeded: "run_not_cancellable_succeeded",
  run_not_cancellable_failed: "run_not_cancellable_failed",
  run_not_cancellable_cancelled: "run_not_cancellable_cancelled",
  run_not_dismissable_queued: "run_not_dismissable_queued",
  run_not_dismissable_running: "run_not_dismissable_running",
  ai_credential_not_found: "ai_credential_not_found",
  invalid_request: "invalid_request",
  signed_out: "signed_out",
  no_active_organization: "no_active_organization",
  forbidden: "forbidden",
};

/**
 * The one argument any refusal needs, and it does not travel on the wire.
 *
 * `MAX_CONCURRENT_RUNS` is exported from `@pubrick/shared` precisely so the UI
 * and the api cannot promise different rules — the compose screen already names
 * the same number. Reading it here rather than parsing it out of the api's
 * English sentence is what keeps that true in Russian.
 */
const ERROR_MESSAGE_VALUES: Partial<Record<ErrorCode, Record<string, string | number>>> = {
  run_limit_reached: { limit: MAX_CONCURRENT_RUNS },
  refine_limit_reached: { limit: MAX_REFINE_CALLS_PER_HOUR },
};

/**
 * What `errorMessage` needs of a translator: a key, and optionally the values to
 * interpolate. Structurally satisfied by `useTranslations("Errors")`.
 */
export type ErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * What to actually show the user for a failed request.
 *
 * THREE answers, in falling order of how much each one knows.
 *
 * 1. THE CODE. A refusal that named itself (`ApiErrorBody.code`, or one of the
 *    web's own `TRANSPORT_ERROR_CODES`) is turned into a sentence in the
 *    reader's language. This is the whole point: the api's prose is English,
 *    this product ships in four languages, and it also speaks a different
 *    vocabulary than the screens do — the server says "content item" where
 *    every screen says "post".
 * 2. THE SERVER'S SENTENCE, for a 4xx with no code this build knows. That is a
 *    refusal not yet converted, and a code from an api NEWER than this build —
 *    a released server against a cached client, which is ordinary. The sentence
 *    is specific, actionable, and (unlike a provider's error text, which is why
 *    `runFailureMessage` must NOT do this) cannot contain a secret: it is
 *    written in this repository. Untranslated and true beats translated and
 *    vague, and beats a rendered key path or a blank line outright.
 * 3. THE CALLER'S FALLBACK, for a 5xx, a failure with no HTTP status at all
 *    (network down, DNS, a proxy's own error page), or an unknown code that
 *    brought no sentence either. None of those says anything the user can act
 *    on, which is the point of the per-screen `genericError` keys. A network
 *    failure that never reached the server is wrapped as `ApiError(0, ...)`
 *    (see `api()` below) and must land here too — hence the lower bound on the
 *    status test, not just `< 500`.
 *
 * `t` IS REQUIRED. It was optional for exactly as long as the conversion took:
 * an omitted translator does not fail, it silently drops the reader to step 2
 * and puts the api's English on a Spanish screen, which is the defect this
 * whole path exists to remove — and no test of a screen that never provokes a
 * refusal can see it. Making it required moves that from something each new
 * screen has to remember to something the compiler will not let it forget;
 * `error-message-arity.test.ts` asks the compiler whether it still would.
 */
export function errorMessage(err: unknown, fallback: string, t: ErrorTranslator): string {
  if (!(err instanceof ApiError)) return fallback;
  if (isErrorCode(err.code)) {
    return t(ERROR_MESSAGE_KEYS[err.code], ERROR_MESSAGE_VALUES[err.code]);
  }
  return err.status >= 400 && err.status < 500 && err.message.length > 0 ? err.message : fallback;
}

/**
 * Nest error bodies are `{ statusCode, message, error }`; message may be a
 * string[]. A coded refusal adds `code` (see `refusalBody` in `@pubrick/shared`)
 * and changes nothing else, so this reads both shapes.
 */
function serverFailure(raw: string): { message?: string; code?: string } {
  try {
    const body = JSON.parse(raw) as { message?: unknown; code?: unknown };
    const code = typeof body.code === "string" && body.code.length > 0 ? body.code : undefined;
    if (typeof body.message === "string" && body.message.length > 0) {
      return { message: body.message, code };
    }
    if (Array.isArray(body.message) && body.message.length > 0) {
      return { message: body.message.join(", "), code };
    }
    return { code };
  } catch {
    // Not JSON (proxy error page, gateway timeout) — never surface the raw body.
    return {};
  }
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
    const { message: detail, code } = serverFailure(raw);
    if (res.status === 401) {
      // Deliberately NOT "your session has expired". A 401 says only that the
      // request carried no valid session — which is equally true of a session
      // that timed out, one revoked elsewhere, and one the person ended by
      // pressing Sign out a second ago. better-auth gives the browser no way
      // to tell those apart (`useSession` reports every one of them as
      // `data: null`), and the old sentence told a user who had just signed
      // out that something had gone wrong. "Signed out" is the one claim true
      // in every case.
      //
      // The sentence is not the way back, and must never be left to be: the
      // session store has no idea this request was refused, so on a screen that
      // is polling — the one place a session dies with nobody navigating —
      // saying it and stopping would be the whole of what the reader got.
      // Reporting it is what turns the refusal into a trip to the login screen;
      // see `unauthorized.ts` and AppShell's guard.
      reportUnauthorized();
      throw new ApiError(401, "You're signed out. Log in again to continue.", false, "signed_out");
    }
    if (res.status === 403) {
      // THE CODE, not the sentence. This branch decides whether the reader is
      // sent to onboarding, and it used to decide it by matching
      // /no active organization/i against prose written for a network tab —
      // so rewording that sentence server-side, or translating it, would have
      // silently stranded an account on a screen it can never load.
      //
      // Deliberately NOT a code-or-sniff disjunction. A fallback would keep
      // this working with the guard's code removed, which is exactly the
      // shape of test that reports a line as pinned while pinning nothing:
      // the api and the web ship together here, and the one thing worth
      // knowing is that the code arrives.
      const noActiveOrg = code === "no_active_organization";
      throw new ApiError(
        403,
        noActiveOrg
          ? "No active organization — create or select one first."
          : "You don't have access to this.",
        noActiveOrg,
        noActiveOrg ? "no_active_organization" : "forbidden",
      );
    }
    throw new ApiError(
      res.status,
      detail ?? res.statusText ?? `Request failed (${res.status})`,
      false,
      code ?? null,
    );
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
