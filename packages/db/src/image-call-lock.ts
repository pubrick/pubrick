import type pg from "pg";

/**
 * Keep the count, provider call, and usage write in one per-org critical section.
 * A try-lock refuses competing calls promptly rather than filling the pool with
 * waiters while the holder needs another connection to record its usage.
 */
export async function withImageCallLock<T>(
  pool: pg.Pool,
  orgId: string,
  call: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect();
  const key = `image-call-budget:${orgId}`;
  let discardConnection = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
      [key],
    );
    if (!lock.rows[0]?.acquired) return { acquired: false };
    try {
      return { acquired: true, value: await call() };
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch {
        discardConnection = true;
      }
    }
  } finally {
    client.release(discardConnection);
  }
}
