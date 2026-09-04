import { defineRouting } from "next-intl/routing";
import { LOCALE_COOKIE } from "./locale-cookie";

/**
 * The one list of shipped languages.
 *
 * `messages/*.json` are held at key parity against it by
 * `src/test/messages-parity.test.ts`, and the language switcher derives its
 * options from `locales` here — so adding a fifth locale is a change to this
 * file plus a message file, and to nothing else.
 */
export const routing = defineRouting({
  locales: ["en", "es", "ru", "pt"],
  defaultLocale: "en",
  // Same attributes the client-side switcher writes, so the middleware's own
  // write and ours cannot disagree about how long a choice lasts.
  localeCookie: LOCALE_COOKIE,
});
