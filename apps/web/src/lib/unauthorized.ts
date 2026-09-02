/**
 * The one thing about a session only the API can tell us.
 *
 * `authClient.useSession()` is a module-level store, and nothing writes to it
 * when a request to *our* API is refused: better-auth refreshes it on mount,
 * on `visibilitychange`, and on `online`, and on nothing else. A session that
 * expires while somebody is watching a poll therefore leaves the store still
 * reporting a user — so the shell's guard, which reads only that store, has no
 * idea anything happened, and the screen sits there with a stopped poll and a
 * red sentence until its owner switches tabs.
 *
 * A 401 IS the server's answer about the session. This is the wire that
 * carries it from the request wrapper, which is the only code that sees one,
 * to the shell, which is the only code that can do something about it. Kept in
 * its own module rather than in `api.ts` so the wrapper stays free of anything
 * React-shaped, and so the subscription has one obvious place to be read from.
 *
 * Deliberately not a "session expired" claim: see `auth-routes.ts`. All this
 * says is that the server has just refused a request for want of a session.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Subscribe to 401s. Returns the unsubscribe, so an effect can return it
 * directly.
 */
export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Called by `api.ts` for every 401, before the error is thrown — the throw is
 * what the call site handles, this is what the app as a whole does about it.
 *
 * The live Set is walked, not a copy: a listener that unsubscribes itself
 * mid-call (the shell's cleanup, on the unmount its own redirect causes) is
 * something Set iteration already tolerates, and a copy would only change the
 * one case where the current behaviour is also the right one — a listener
 * dropped by an earlier listener should not then be called.
 */
export function reportUnauthorized(): void {
  for (const listener of listeners) listener();
}
