import { hasLocale } from "next-intl";
import { LOCALE_COOKIE } from "@/i18n/locale-cookie";
import { routing } from "@/i18n/routing";

export type LocaleOption = { value: string; label: string };

/**
 * What a language calls itself.
 *
 * Asked of `Intl.DisplayNames` in the language being named, rather than kept in
 * a table beside the routing config: a hand-kept table is a second list to
 * forget, and forgetting it is silent — the fifth locale would appear in the
 * switcher under its wire id. A Russian speaker scanning the strip is looking
 * for "Русский", and `ru` is not it.
 *
 * ICU returns these lower-cased where the language's own orthography does not
 * capitalise them ("español", "português"). They are labels of a control here,
 * not words in a sentence, so the first letter is raised — in the target
 * language's own casing rules, which is why `toLocaleUpperCase` takes the
 * locale.
 */
function nativeName(locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(locale);
    // `of()` echoes the code back when it knows no name for it. Nothing to
    // capitalise then, and "En" would be worse than "en".
    if (!name || name === locale) return locale;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    // An environment without full ICU, or a tag `Intl` rejects outright. The
    // code is a poor label and an honest one; an empty strip would be neither.
    return locale;
  }
}

/**
 * Every language this app ships, in routing order, each named in itself.
 *
 * Derived from `routing.locales` on every call rather than frozen at module
 * load, so a test can stand a different routing config in front of it and see
 * the switcher follow — which is the property that makes "add a locale in one
 * place" true rather than merely intended.
 */
export function localeOptions(): LocaleOption[] {
  return routing.locales.map((locale) => ({ value: locale, label: nativeName(locale) }));
}

/**
 * The same screen, in another language.
 *
 * The locale is a path segment, so switching language is a NAVIGATION, and the
 * address it navigates to has to be the one the reader is already looking at —
 * a nested path with its query intact, not a trip back to the queue. Only the
 * FIRST segment is touched: `/en/brands/ru` is a brand whose slug happens to
 * read like a locale, and it stays one.
 *
 * `search` is passed in rather than read from `useSearchParams()` on purpose.
 * That hook opts its whole page out of static rendering unless it is wrapped in
 * a Suspense boundary, and this value is wanted at the moment of a click, not
 * during render — `window.location.search` is both cheaper and exactly current.
 */
export function localeSwitchHref(pathname: string, search: string, nextLocale: string): string {
  const query =
    search === "" || search === "?" ? "" : search.startsWith("?") ? search : `?${search}`;
  const segments = pathname.split("/");
  if (hasLocale(routing.locales, segments[1])) {
    segments[1] = nextLocale;
    return `${segments.join("/")}${query}`;
  }
  // No prefix yet — a path the proxy has not redirected. Prefixing it is the
  // right answer; overwriting segment 1 would eat a real path segment.
  const rest = pathname === "/" ? "" : pathname;
  return `/${nextLocale}${rest}${query}`;
}

/**
 * Records the choice where the SERVER can read it on the next visit.
 *
 * Deliberately a cookie and not `localStorage`, which is where the theme
 * preference lives: the language has to be known before the first byte of HTML
 * is rendered, and the only thing that travels with that request is a cookie.
 * A localStorage copy could only be applied after paint, as a redirect — a
 * flash of the wrong language on every cold load.
 *
 * Cookies can be refused (a locked-down browser, an embedded webview), and a
 * refusal here must not take the switch down with it: the navigation is what
 * the reader asked for, and the URL they land on carries the language on its
 * own. Only the memory of the choice is lost.
 */
export function rememberLocale(locale: string): void {
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is asynchronous and absent from Safari, and this write has to land before the navigation on the next line. `document.cookie` is also exactly what next-intl's own client-side locale switch writes.
    document.cookie = `${LOCALE_COOKIE.name}=${locale};path=/;max-age=${LOCALE_COOKIE.maxAge};samesite=${LOCALE_COOKIE.sameSite}`;
  } catch {
    // Storage refused. The navigation below it still happens.
  }
}
