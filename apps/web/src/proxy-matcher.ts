/**
 * The proxy's route matcher, split out so it can be imported with zero
 * transitive dependencies.
 *
 * `proxy.test.ts` imports this directly instead of executing `proxy.ts`
 * (which pulls in next-intl's middleware, and that eagerly does
 * `import "next/server"` — an import that fails to resolve under vitest's
 * ESM loader in this pnpm workspace, even though the production build and a
 * running `next start` both exercise `proxy.ts` fine). Keeping this file
 * import-free is what sidesteps that crash, so don't add imports here.
 *
 * `proxy.ts` does NOT import this constant as a value: Next statically
 * parses `config.matcher` at build time and requires an inline literal
 * there, rejecting both an imported identifier and a local variable
 * (confirmed by two real Turbopack build failures). So `proxy.ts` keeps its
 * own inline copy of this exact array — see the `ProxyMatcher` type below
 * for how that copy is kept from drifting.
 */
export const PROXY_MATCHER = ["/((?!api|_next|.*\\..*).*)"] as const;

/**
 * A type-only companion to PROXY_MATCHER. `proxy.ts` imports only this type
 * (erased at compile time, so it doesn't touch Next's runtime bundling or
 * its static `config.matcher` parsing) and annotates its own inline literal
 * with it, so a hand-edit that lets the two arrays diverge fails
 * `tsc --noEmit` / `next build`'s TypeScript pass instead of drifting
 * silently.
 */
export type ProxyMatcher = typeof PROXY_MATCHER;
