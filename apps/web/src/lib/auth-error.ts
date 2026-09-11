import { ORIGIN_MISMATCH_CODE } from "@pubrick/shared";

/**
 * What the login screen shows for a refused sign-in.
 *
 * better-auth's client does not throw: it returns `{ data, error }`, where
 * `error` is the refusal's JSON body spread over `status`/`statusText`
 * (`@better-fetch/fetch`). So every field the api put in the body arrives here,
 * codes included — which is what lets ONE refusal be translated without
 * inventing a parallel error pipeline for the auth surface.
 *
 * ONE code is translated, deliberately. better-auth's own codes
 * (`INVALID_EMAIL_OR_PASSWORD`, `INVALID_ORIGIN`, …) keep their English
 * sentence, exactly as they did before this function existed: they are the
 * library's vocabulary, not this product's, and inventing four translations per
 * upstream code is a promise this repository cannot keep across upgrades.
 * `ORIGIN_MISMATCH` is different — it is ours, it is the one refusal a
 * first-run install hits before it has any account at all, and its whole point
 * is to be readable by the person who wrote the `.env`.
 *
 * THE TWO HALVES COME FROM DIFFERENT PLACES, and that is not an accident. The
 * origin the browser is on is read LOCALLY (`window.location.origin`) rather
 * than echoed back from the api, because the api learnt it from an
 * attacker-controlled `Origin` header; only the operator's own configured
 * origin travels on the wire. An api too old to send `expectedOrigin` falls
 * through to its English sentence rather than rendering a half-empty one.
 */
export type AuthClientError = {
  message?: string | null;
  code?: string | null;
  expectedOrigin?: string | null;
};

export type AuthErrorTranslator = (key: string, values?: Record<string, string | number>) => string;

export function authErrorMessage(
  error: AuthClientError,
  browserOrigin: string,
  t: AuthErrorTranslator,
): string {
  if (
    error.code === ORIGIN_MISMATCH_CODE &&
    typeof error.expectedOrigin === "string" &&
    error.expectedOrigin.length > 0 &&
    browserOrigin.length > 0
  ) {
    return t("originMismatch", { opened: browserOrigin, configured: error.expectedOrigin });
  }
  return error.message ?? t("genericError");
}

/** The origin the reader actually typed, or "" where there is no window (SSR). */
export function browserOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}
