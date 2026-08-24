import pg from "pg";
import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;

/** Creates a throwaway database on the same server and returns its url + a dropper. */
async function withFreshDatabase(
  baseUrl: string,
): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `pubrick_fresh_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const fresh = new URL(baseUrl);
  fresh.pathname = `/${name}`;
  return {
    url: fresh.toString(),
    drop: async () => {
      const cleanup = new pg.Client({ connectionString: baseUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

describe.skipIf(!url)("runMigrations", () => {
  it("applies migrations and enables pgvector", async () => {
    await runMigrations(url as string);
    const { db, pool } = createDb(url as string);
    const rows = await db.execute("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    await pool.end();
    expect(rows.rows).toHaveLength(1);
  });

  it("creates the better-auth tables", async () => {
    await runMigrations(url as string);
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user','session','account','verification','organization','member','invitation')",
    );
    await pool.end();
    expect(rows.rows).toHaveLength(7);
  });

  it("creates brands and channels with org scoping columns", async () => {
    await runMigrations(url as string);
    const { db, pool } = createDb(url as string);
    const cols = await db.execute(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('brands','channels') AND column_name = 'org_id'",
    );
    await pool.end();
    expect(cols.rows).toHaveLength(2);
  });

  // Regression: parallel vitest workers (and two api replicas booting together) each call
  // runMigrations against the same database. Without the advisory lock this raced on
  // CREATE EXTENSION vector / CREATE SCHEMA drizzle and failed with duplicate-key errors.
  it("survives concurrent runs against a fresh database", async () => {
    const fresh = await withFreshDatabase(url as string);
    try {
      await Promise.all([
        runMigrations(fresh.url),
        runMigrations(fresh.url),
        runMigrations(fresh.url),
      ]);
      const { db, pool } = createDb(fresh.url);
      const rows = await db.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user','organization','member','brands','channels')",
      );
      const ext = await db.execute("SELECT extname FROM pg_extension WHERE extname = 'vector'");
      await pool.end();
      expect(rows.rows).toHaveLength(5);
      expect(ext.rows).toHaveLength(1);
    } finally {
      await fresh.drop();
    }
  });

  it("creates the publishing tables with org scoping", async () => {
    await runMigrations(url as string);
    const { db, pool } = createDb(url as string);
    const cols = await db.execute(
      "SELECT table_name FROM information_schema.columns WHERE table_name IN ('content_items','adaptations','publications') AND column_name = 'org_id'",
    );
    await pool.end();
    expect(cols.rows).toHaveLength(3);
  });
});
