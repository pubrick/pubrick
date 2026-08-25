import { readFileSync } from "node:fs";
import { join } from "node:path";
// This Next version (16.3.2) still ships this API under its middleware-era
// name; `unstable_doesProxyMatch` isn't exported yet (checked against
// node_modules/next/dist/experimental/testing/server) — using the available
// name rather than substituting a hand-rolled regex test, since this runs
// the same matcher-matching machinery Next evaluates at request time.
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

/**
 * `import { config } from "./proxy"` would be the direct way to get the real
 * matcher, but executing proxy.ts pulls in next-intl's middleware, which
 * eagerly does `import "next/server"` — that fails to resolve under
 * vitest's ESM loader in this pnpm workspace ("Cannot find module
 * .../next-intl/node_modules/next/server"). It is NOT a problem with the
 * matcher or with proxy.ts itself: the production build and a running
 * `next start` both exercise proxy.ts fine (verified separately). Reading
 * the `matcher` literal out of the real source file — rather than
 * hardcoding a copy — keeps this test tied to proxy.ts, so it still fails
 * if that file's matcher ever changes.
 */
function readMatcherFromProxySource(): string[] {
  const source = readFileSync(join(process.cwd(), "src/proxy.ts"), "utf8");
  const match = source.match(/matcher:\s*(\[[^\]]*\])/);
  const literal = match?.[1];
  if (!literal) throw new Error("could not find `config.matcher` in proxy.ts");
  return JSON.parse(literal);
}

const config = { matcher: readMatcherFromProxySource() };

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
