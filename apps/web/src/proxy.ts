import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import type { ProxyMatcher } from "./proxy-matcher";

export default createMiddleware(routing);

// Next statically parses this file's `config.matcher` at build time — it
// must be an inline literal array of strings, not an imported reference
// or even a local variable (confirmed by two real build failures: neither
// `matcher: PROXY_MATCHER` nor `const matcher = [...]; export const config
// = { matcher }` survive Next's "static string or array of static strings"
// check). The `ProxyMatcher` type annotation below is a type-only import
// (erased before Next's bundling/parsing), so it's safe here — it makes a
// hand-edit that lets this literal diverge from PROXY_MATCHER in
// ./proxy-matcher.ts fail `tsc --noEmit` / `next build`'s TypeScript pass
// instead of drifting apart silently. proxy.test.ts imports PROXY_MATCHER
// directly to exercise the real matcher without executing this file.
export const config: { matcher: ProxyMatcher } = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
