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
 * Origin mismatch and the ownership/recovery codes used by Pubrick's hosted
 * journey are translated. Unrecognized upstream codes keep the server's
 * sentence so SDK upgrades cannot silently invent recovery promises.
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
  if (error.code === "EMAIL_NOT_VERIFIED") return t("verificationHint");
  if (error.code === "INVALID_TOKEN" || error.code === "TOKEN_EXPIRED")
    return t("invalidRecoveryLink");
  if (error.code === "RESET_PASSWORD_DISABLED") return t("recoveryUnavailable");
  return error.message ?? t("genericError");
}

/** The origin the reader actually typed, or "" where there is no window (SSR). */
export function browserOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}
