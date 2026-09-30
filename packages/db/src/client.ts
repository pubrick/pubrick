import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export function createDb(
  connectionString: string,
  options: Pick<pg.PoolConfig, "max" | "connectionTimeoutMillis" | "idleTimeoutMillis"> = {},
): {
  db: NodePgDatabase<typeof schema>;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({ connectionString, ...options });
  return { db: drizzle(pool, { schema }), pool };
}
