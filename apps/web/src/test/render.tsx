import { type RenderOptions, render as rtlRender } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { act, type ReactElement, type ReactNode, Suspense } from "react";
import messages from "../../messages/en.json";

function Providers({ children }: { children: ReactNode }) {
  // The app's own layout passes no props (next-intl reads server context);
  // in tests the provider needs them explicitly.
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <Suspense fallback={<div>loading</div>}>{children}</Suspense>
    </NextIntlClientProvider>
  );
}

/** For components that do NOT suspend. */
export function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, { wrapper: Providers, ...options });
}

/**
 * For components that suspend — i.e. any page doing `use(params)`.
 *
 * The render call MUST be inside the async act(). Rendering first and
 * flushing afterwards does NOT work: the component stays stuck in the
 * Suspense fallback until the test times out. This is undocumented
 * upstream and was established by bisection — do not "simplify" it.
 */
export async function renderAsync(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  let result!: ReturnType<typeof rtlRender>;
  await act(async () => {
    result = rtlRender(ui, { wrapper: Providers, ...options });
  });
  return result;
}

export * from "@testing-library/react";
