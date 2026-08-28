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

  it("creates the generation tables with org scoping", async () => {
    await runMigrations(url as string);
    const { db, pool } = createDb(url as string);
    const cols = await db.execute(
      "SELECT table_name FROM information_schema.columns WHERE table_name IN ('ai_credentials','usage_ledger','pipeline_runs','content_versions') AND column_name = 'org_id' AND is_nullable = 'NO'",
    );
    const idx = await db.execute(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('pipeline_runs_status_idx','content_versions_content_item_id_idx','ai_credentials_org_id_provider_idx')",
    );
    await pool.end();
    expect(cols.rows).toHaveLength(4);
    expect(idx.rows).toHaveLength(3);
  });

  // The origin columns are added to tables that already hold rows, so the
  // default is what keeps every pre-AI row correct rather than NULL-or-guessed.
  it("adds origin and first_opened_at to the existing content tables", async () => {
    await runMigrations(url as string);
    const { db, pool } = createDb(url as string);
    const cols = await db.execute(
      "SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE (table_name, column_name) IN (('content_items','origin'),('content_items','first_opened_at'),('adaptations','origin'))",
    );
    await pool.end();
    const byKey = new Map<string, (typeof cols.rows)[number]>(
      cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
    );
    expect(byKey.size).toBe(3);
    for (const key of ["content_items.origin", "adaptations.origin"]) {
      expect(byKey.get(key)?.is_nullable).toBe("NO");
      expect(byKey.get(key)?.column_default).toBe("'human'::text");
    }
    expect(byKey.get("content_items.first_opened_at")?.is_nullable).toBe("YES");
  });

  // The ledger must be able to say "this call could not be priced". A NOT NULL
  // cost column would force a zero, and SUM() would then report a confident lie.
  it("keeps the ledger cost nullable at numeric(12,6)", async () => {
    await runMigrations(url as string);
    const { db, pool } = createDb(url as string);
    const cols = await db.execute(
      "SELECT is_nullable, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = 'usage_ledger' AND column_name = 'cost_usd'",
    );
    await pool.end();
    expect(cols.rows).toHaveLength(1);
    expect(cols.rows[0]).toMatchObject({
      is_nullable: "YES",
      data_type: "numeric",
      numeric_precision: 12,
      numeric_scale: 6,
    });
  });
});
