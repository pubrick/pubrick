// `act` comes from RTL, not from React: RTL's re-export is the wrapper that
// sets IS_REACT_ACT_ENVIRONMENT around the callback. Importing `act` straight
// from "react" runs the same updates outside that flag, and React answers with
// "The current testing environment is not configured to support act(...)" for
// every flush — 50 stderr lines that look like an inherent cost of testing
// Suspense and are really this one import.
import { act, type RenderOptions, render as rtlRender } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { type ReactElement, type ReactNode, Suspense } from "react";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import ru from "../../messages/ru.json";

/**
 * Every language this product ships, so a test can render a screen in one that
 * is not English.
 *
 * `en` is the default and every existing test relies on it. The other three are
 * here because a whole class of defect is invisible in English: a screen that
 * renders the api's own sentence rather than asking for a translated one looks
 * perfectly correct to an English reader and is the api's English to everyone
 * else. `refusals.test.tsx` is what that buys — it asserts on the Spanish and
 * Russian sentences themselves, out of the shipped message files.
 */
const MESSAGES = { en, es, ru, pt } as const;
export type TestLocale = keyof typeof MESSAGES;

export type TestRenderOptions = Omit<RenderOptions, "wrapper"> & { locale?: TestLocale };

function providersFor(locale: TestLocale) {
  return function Providers({ children }: { children: ReactNode }) {
    // The app's own layout passes no props (next-intl reads server context);
    // in tests the provider needs them explicitly.
    return (
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        <Suspense fallback={<div>loading</div>}>{children}</Suspense>
      </NextIntlClientProvider>
    );
  };
}

/** For components that do NOT suspend. */
export function render(ui: ReactElement, options?: TestRenderOptions) {
  const { locale = "en", ...rest } = options ?? {};
  return rtlRender(ui, { wrapper: providersFor(locale), ...rest });
}

/**
 * For components that suspend — i.e. any page doing `use(params)`.
 *
 * The render call MUST be inside the async act(). Rendering first and
 * flushing afterwards does NOT work: the component stays stuck in the
 * Suspense fallback until the test times out. This is undocumented
 * upstream and was established by bisection — do not "simplify" it.
 */
export async function renderAsync(ui: ReactElement, options?: TestRenderOptions) {
  const { locale = "en", ...rest } = options ?? {};
  let result!: ReturnType<typeof rtlRender>;
  await act(async () => {
    result = rtlRender(ui, { wrapper: providersFor(locale), ...rest });
  });
  return result;
}

export * from "@testing-library/react";
