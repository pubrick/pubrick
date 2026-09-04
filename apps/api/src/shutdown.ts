import type { INestApplication } from "@nestjs/common";
import type { createDb } from "@pubrick/db";

// apps/api has no direct dependency on `pg` (only @pubrick/db does), so the
// pool's type is derived from what createDb actually returns rather than
// imported from a package that is not in this app's own package.json.
type Pool = ReturnType<typeof createDb>["pool"];

/**
 * Closes the api process the same way `apps/worker/src/main.ts` closes the
 * worker: Nest first, so every provider's `onModuleDestroy` — QueueService's
 * graceful `boss.stop({ graceful: true })` among them — gets to run while the
 * database is still reachable, then the pool the api's repositories and
 * better-auth's drizzle adapter all share (`./db`).
 *
 * Without this, `docker compose up -d --build` — the command the self-hosting
 * doc tells an operator to run to upgrade — sends the container runtime's
 * SIGTERM straight to a process with no handler for it. The runtime's default
 * grace period lets the process linger, but nothing in it stops accepting new
 * queries or waits for the ones already running; the container is simply
 * killed out from under them once the grace period elapses, exactly what the
 * worker's own shutdown path was written to avoid on its side.
 *
 * `pool.end()` does not abort a query in flight: node-postgres marks the pool
 * as ending, removes idle clients immediately, but leaves a checked-out
 * client alone until the query that is using it finishes and releases it —
 * only then does `end()`'s promise resolve. That is the "let it finish"
 * behaviour this function exists to give the api, proved (not merely
 * asserted) in shutdown.e2e.spec.ts.
 */
export async function closeApi(app: INestApplication, pool: Pool): Promise<void> {
  await app.close();
  await pool.end();
}
