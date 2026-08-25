// This Next version (16.3.2) still ships this API under its middleware-era
// name; `unstable_doesProxyMatch` isn't exported yet (checked against
// node_modules/next/dist/experimental/testing/server) — using the available
// name rather than substituting a hand-rolled regex test, since this runs
// the same matcher-matching machinery Next evaluates at request time.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { PROXY_MATCHER } from "./proxy-matcher";

// Importing this constant directly (instead of `import { config } from
// "./proxy"`) is what avoids executing proxy.ts, which would pull in
// next-intl's middleware and crash under vitest's ESM resolver — see
// proxy-matcher.ts for why that module stays import-free.
//
// proxy.ts can't import PROXY_MATCHER itself as a value: Next statically
// parses `config.matcher` at build time and requires an inline literal
// there (confirmed by two real Turbopack build failures — neither an
// imported identifier nor a local variable survive its "static string or
// array of static strings" check). So proxy.ts keeps its own inline copy
// of this array, type-annotated with proxy-matcher.ts's `ProxyMatcher`
// type (a type-only import, erased before Next's bundling) so the two
// arrays can't silently drift apart — a mismatch fails `tsc --noEmit` /
// `next build`'s TypeScript pass instead.
const config = { matcher: PROXY_MATCHER };

// Note: the guard against proxy.ts's inline literal drifting from
// PROXY_MATCHER is the `ProxyMatcher` type annotation on `config` in
// proxy.ts, checked by `tsc`/`next build` — not by this file. `pnpm test`
// alone would false-green a divergence between the two arrays; CI runs
// typecheck before test, so it's covered end to end.

function matches(url: string): boolean {
  return unstable_doesMiddlewareMatch({ config, url });
}

describe("proxy matcher", () => {
  it("excludes API routes", () => {
    expect(matches("https://example.com/api/anything")).toBe(false);
  });

  it("excludes Next.js internal assets", () => {
    expect(matches("https://example.com/_next/static/x.js")).toBe(false);
  });

  it("matches the site root", () => {
    expect(matches("https://example.com/")).toBe(true);
  });

  it("matches ordinary app routes", () => {
    expect(matches("https://example.com/brands")).toBe(true);
    expect(matches("https://example.com/content/123")).toBe(true);
  });
});
