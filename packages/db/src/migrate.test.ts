import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;

/** The migration whose additivity is proved below, by name rather than by index. */
const ADDITIVE_MIGRATION = "0006_authorship";

/** The index-only migration proved additive AND non-vacuous below. */
const INDEX_MIGRATION = "0007_ledger_draft_index";

/**
 * Copies the migrations folder minus `tag` and everything after it, so a
 * database can be brought to the schema as it stood *before* that migration.
 * Proving a migration additive needs rows that predate it, and rows that
 * predate it can only be written against the older schema.
 */
async function migrationsFolderBefore(tag: string): Promise<string> {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const journalPath = path.join("meta", "_journal.json");
  const journal = JSON.parse(await fs.readFile(path.join(source, journalPath), "utf8")) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === tag);
  if (cut === -1) throw new Error(`No migration tagged ${tag} in the journal`);
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pubrick-migrations-"));
  await fs.cp(source, dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, journalPath),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }),
  );
  return dir;
}

/**
 * The throwaway databases this file makes, and the millisecond stamp in each
 * name. The stamp is what lets a later run judge a leftover's age without
 * having recorded anything about it — matching and parsing come from one
 * expression, so a rename cannot leave the sweep matching names it can no
 * longer read.
 */
const FRESH_DATABASE = /^pubrick_fresh_(\d+)_\d+$/;

/**
 * How old a leftover must be before a later run drops it. Far longer than any
 * run of this suite, so the sweep can never take a database a CONCURRENT run is
 * still using — `WITH (FORCE)` would terminate its connections mid-migration.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Creates a throwaway database on the same server and returns its url + a
 * dropper.
 *
 * The dropper runs from a `finally`, which covers a failing assertion but not a
 * killed process: Ctrl-C or a vitest timeout kill leaves the database behind,
 * and each call site leaks one. So creation also sweeps — any `pubrick_fresh_*`
 * older than `STALE_AFTER_MS` is dropped first, which makes the next run clean
 * up after the last one that died. Best effort by design: a sweep that cannot
 * drop something is not a reason to fail a migration test.
 */
async function withFreshDatabase(
  baseUrl: string,
): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `pubrick_fresh_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await dropStaleDatabases(admin);
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

/** Drops whatever a killed run left behind. Never throws: see `withFreshDatabase`. */
async function dropStaleDatabases(admin: pg.Client): Promise<void> {
  try {
    const { rows } = await admin.query<{ datname: string }>("SELECT datname FROM pg_database");
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const { datname } of rows) {
      const stamp = FRESH_DATABASE.exec(datname);
      if (stamp === null || Number(stamp[1]) > cutoff) continue;
      // Interpolated, but only ever a name this regex just matched: digits and
      // the literal prefix, so there is nothing here to quote out of.
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } catch {
    // A leftover we could not drop is a leftover; the test it would have been
    // cleaning up for has not started yet and is none the worse for it.
  }
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

  // `scope` lands on a table that already holds rows, and every one of them is a
  // whole body — so the default is what keeps them restorable rather than
  // NULL-or-guessed, exactly as the origin columns above.
  it("adds the version scope and the ledger's draft columns", async () => {
    await runMigrations(url as string);
    const { db, pool } = createDb(url as string);
    const cols = await db.execute(
      "SELECT table_name, column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE (table_name, column_name) IN (('content_versions','scope'),('usage_ledger','content_item_id'),('usage_ledger','adaptation_id'))",
    );
    // Money outlives what it was spent on: deleting a draft must blank the
    // ledger's pointer, never take the row (and its cost) with it.
    const fks = await db.execute(
      `SELECT kcu.column_name, rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
        WHERE kcu.table_name = 'usage_ledger'
          AND kcu.column_name IN ('content_item_id', 'adaptation_id')`,
    );
    await pool.end();
    const byKey = new Map<string, (typeof cols.rows)[number]>(
      cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]),
    );
    expect(byKey.size).toBe(3);
    expect(byKey.get("content_versions.scope")).toMatchObject({
      is_nullable: "NO",
      data_type: "text",
      column_default: "'full'::text",
    });
    for (const key of ["usage_ledger.content_item_id", "usage_ledger.adaptation_id"]) {
      expect(byKey.get(key)).toMatchObject({ is_nullable: "YES", data_type: "uuid" });
    }
    expect(
      Object.fromEntries(fks.rows.map((r) => [r.column_name as string, r.delete_rule])),
    ).toEqual({ content_item_id: "SET NULL", adaptation_id: "SET NULL" });
  });

  // The proof that 0006 is additive: rows written against the pre-0006 schema
  // must survive it unchanged, and must mean afterwards what they meant before.
  // A version row that came back as `fragment` — or came back with a rewritten
  // body or timestamp — would be history the app can no longer restore.
  it("leaves rows written before the scope column exactly as they were", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(ADDITIVE_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seeded: { version: pg.QueryResultRow; ledger: pg.QueryResultRow };
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        // If the columns already existed here, "seeded before the migration"
        // would be a lie and the assertions below would prove nothing.
        const pre = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE (table_name, column_name) IN (('content_versions','scope'),('usage_ledger','content_item_id'),('usage_ledger','adaptation_id'))",
        );
        expect(pre.rows).toHaveLength(0);

        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('org_additive', 'Additive', 'additive')",
        );
        const brand = await pool.query(
          "INSERT INTO brands (org_id, name) VALUES ('org_additive', 'Brand') RETURNING id",
        );
        const item = await pool.query(
          "INSERT INTO content_items (org_id, brand_id, body) VALUES ('org_additive', $1, 'the body') RETURNING id",
          [brand.rows[0].id],
        );
        const version = await pool.query(
          "INSERT INTO content_versions (org_id, content_item_id, body, title, origin) VALUES ('org_additive', $1, 'the first draft', 'A title', 'ai') RETURNING id, body, title, origin, created_at",
          [item.rows[0].id],
        );
        const ledger = await pool.query(
          "INSERT INTO usage_ledger (org_id, step, provider, model_id, cost_usd, cost_source, status) VALUES ('org_additive', 'writer', 'google', 'gemini-3-flash', 0.001234, 'price_table', 'ok') RETURNING id, step, model_id, cost_usd, cost_source, created_at",
        );
        seeded = { version: version.rows[0], ledger: ledger.rows[0] };
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      const versions = await after.query(
        "SELECT id, body, title, origin, scope, created_at FROM content_versions",
      );
      const ledgers = await after.query(
        "SELECT id, step, model_id, cost_usd, cost_source, content_item_id, adaptation_id, created_at FROM usage_ledger",
      );
      await after.end();

      expect(versions.rows).toEqual([{ ...seeded.version, scope: "full" }]);
      expect(ledgers.rows).toEqual([
        { ...seeded.ledger, content_item_id: null, adaptation_id: null },
      ]);
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  // 0007 adds an index and nothing else, which is precisely why an end-state
  // assertion after runMigrations() would prove nothing: it cannot tell 0007
  // from an empty file that some later migration happened to cover. So the
  // index's ABSENCE at 0006 is asserted first — that is the check the previous
  // migration task found its own test was missing — and the rows the index is
  // built over are real, written through the columns 0006 added, and compared
  // field for field afterwards. `CREATE INDEX` takes a lock and rewrites
  // nothing; this is the assertion that says so rather than assuming it.
  it("adds the ledger's draft index without touching the rows it indexes", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(INDEX_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seeded: pg.QueryResultRow[];
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        const pre = await pool.query(
          "SELECT indexname FROM pg_indexes WHERE tablename = 'usage_ledger'",
        );
        // If 0006 already created it, "0007 added it" would be a lie and the
        // assertion below would pass over an empty migration file.
        expect(pre.rows.map((r) => r.indexname)).not.toContain("usage_ledger_content_item_id_idx");
        // The columns themselves must be there, or the seed below cannot fill
        // them and the index would be proved over rows that never used it.
        const cols = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_ledger' AND column_name IN ('content_item_id','adaptation_id')",
        );
        expect(cols.rows).toHaveLength(2);

        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('org_index', 'Indexed', 'indexed')",
        );
        const brand = await pool.query(
          "INSERT INTO brands (org_id, name) VALUES ('org_index', 'Brand') RETURNING id",
        );
        const channel = await pool.query(
          "INSERT INTO channels (org_id, brand_id, platform, name, credentials_encrypted) VALUES ('org_index', $1, 'telegram', 'Notes', 'blob') RETURNING id",
          [brand.rows[0].id],
        );
        const item = await pool.query(
          "INSERT INTO content_items (org_id, brand_id, body) VALUES ('org_index', $1, 'the body') RETURNING id",
          [brand.rows[0].id],
        );
        const adaptation = await pool.query(
          "INSERT INTO adaptations (org_id, content_item_id, channel_id) VALUES ('org_index', $1, $2) RETURNING id",
          [item.rows[0].id, channel.rows[0].id],
        );
        // One row of each kind the ledger holds: a refine, which is what the
        // index is for, and an ordinary in-run call, which names no draft and
        // must come back naming none.
        const ledger = await pool.query(
          `INSERT INTO usage_ledger (org_id, step, provider, model_id, cost_usd, cost_source, status, content_item_id, adaptation_id)
             VALUES ('org_index', 'refine', 'google', 'gemini-3-flash', 0.000420, 'price_table', 'ok', $1, $2),
                    ('org_index', 'writer', 'google', 'gemini-3-flash', 0.001234, 'price_table', 'ok', NULL, NULL)
           RETURNING id, step, model_id, cost_usd, cost_source, status, content_item_id, adaptation_id, created_at`,
          [item.rows[0].id, adaptation.rows[0].id],
        );
        seeded = [...ledger.rows].sort((a, b) => String(a.step).localeCompare(String(b.step)));
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      const rows = await after.query(
        "SELECT id, step, model_id, cost_usd, cost_source, status, content_item_id, adaptation_id, created_at FROM usage_ledger ORDER BY step",
      );
      const idx = await after.query(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'usage_ledger'",
      );
      await after.end();

      expect(rows.rows).toEqual(seeded);
      const byName = new Map(idx.rows.map((r) => [r.indexname as string, r.indexdef as string]));
      // Presence first, then shape: an empty 0007 leaves `get` undefined, and
      // `toContain` on undefined reports an argument-type complaint rather than
      // the missing index — an unreadable failure for the one test written to
      // catch a migration that did nothing.
      expect([...byName.keys()]).toContain("usage_ledger_content_item_id_idx");
      expect(byName.get("usage_ledger_content_item_id_idx")).toContain("(content_item_id)");
      // `adaptation_id` gets none, and that is a decision rather than an
      // oversight: every index is paid for on the ledger's hot INSERT path —
      // one row per physical model call — and a btree indexes NULLs, so an
      // index on a column no writer sets buys a per-row cost for a single
      // all-NULL entry. Whoever lets a refine target an adaptation writes that
      // column, and adds the index in the same change.
      expect([...byName.keys()]).not.toContain("usage_ledger_adaptation_id_idx");
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });
});
