import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * Arbitrary but fixed key for pg_advisory_lock. Every process that migrates this
 * database uses it, so concurrent migrators serialise instead of racing on
 * CREATE EXTENSION / CREATE SCHEMA drizzle / the __drizzle_migrations table.
 * Must stay a safe JS integer (pg sends it as text, Postgres parses it as bigint).
 */
const MIGRATION_LOCK_ID = 4_123_975_108_321_452;

function migrationsFolder(): string {
  // dist/ and src/ both sit one level below the package root, where migrations/ lives.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "..", "migrations");
  if (!existsSync(candidate)) {
    throw new Error(`Migrations folder not found at ${candidate}`);
  }
  return candidate;
}

/**
 * Applies pending migrations, serialised across processes by a Postgres advisory
 * lock. Advisory locks are per-session, so this covers both parallel test workers
 * and two api replicas booting at the same time; the lock is held on the same
 * connection the migration runs on and released in a finally (and, if the process
 * dies mid-migration, when the session ends).
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      try {
        await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
