/**
 * The cookie that carries a chosen language from one visit to the next.
 *
 * Kept here, import-free, because it has TWO writers that must agree on it:
 * `proxy.ts`'s next-intl middleware (server, on a document request) and
 * `lib/locale.ts` (client, on a soft navigation). next-intl reads it on the way
 * in — `resolveLocale` prefers a URL prefix, then this cookie, then
 * `Accept-Language` — so it is the only thing that decides which language a
 * returning visitor lands in when they arrive somewhere without a prefix.
 *
 * The two writers exist because neither covers the other. next-intl's
 * middleware deliberately declines to update the cookie for anything that is
 * not `Sec-Fetch-Dest: document` (its own comment: "Locale switches via a soft
 * navigation update the cookie on the client side"), and a `router.replace`
 * from the language switcher is exactly such a soft navigation.
 *
 * `maxAge` is spelled out because next-intl's default omits it, which makes its
 * cookie a SESSION cookie: the choice would survive a reload and die with the
 * browser window. A language is not a per-session decision.
 */
export const LOCALE_COOKIE = {
  name: "NEXT_LOCALE",
  sameSite: "lax",
  /** One year, in seconds. */
  maxAge: 60 * 60 * 24 * 365,
} as const;
