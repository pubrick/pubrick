/**
 * Where an unauthenticated visitor is sent, and how they get back.
 *
 * The return path rides in the URL rather than in storage: the login screen
 * stays a plain, linkable address, and a tab that is closed and reopened does
 * not resurrect somebody else's destination.
 *
 * Nothing here can distinguish a session that expired from one the user
 * deliberately ended — better-auth's `useSession` reports both as
 * `{ data: null }`, and a signed-out `GET /api/auth/get-session` answers 200
 * with a null body rather than an error. So there is one destination and one
 * sentence for both, and no invented "your session expired" claim.
 */

/**
 * A `next` value we are willing to navigate to after login.
 *
 * Same-origin and path-only. A bare leading "/" is NOT enough: browsers read
 * both `//evil.example` and `/\evil.example` as protocol-relative URLs, so an
 * attacker-supplied `?next=` would otherwise turn our own login screen into an
 * open redirect.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw?.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  return raw;
}

/** The login screen, optionally carrying the page the visitor was bounced off. */
export function loginHref(locale: string, next?: string | null): string {
  const base = `/${locale}/login`;
  const target = safeNextPath(next);
  return target === null ? base : `${base}?next=${encodeURIComponent(target)}`;
}
