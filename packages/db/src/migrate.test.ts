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

/** The constraint-only migration, proved against a populated database below. */
const CONSTRAINT_MIGRATION = "0009_declared_invariants";

/** The migration that adds the ledger's outcome column, proved additive below. */
const OUTCOME_MIGRATION = "0012_ledger_call_outcome";

/**
 * Every column 0009 pins, with a value that is not in its set.
 *
 * Driven from a table rather than written out fourteen times, because the point
 * being proved is about the CLASS: a check that exists on twelve of the
 * fourteen looks exactly like one that exists on all of them until the day the
 * thirteenth matters. `schema-invariants.test.ts` holds the other end — that
 * every enum column in the schema has a constraint at all — and this one proves
 * the constraints actually reached the database.
 */
const PINNED_COLUMNS: ReadonlyArray<{ table: string; column: string; bogus: string }> = [
  { table: "channels", column: "platform", bogus: "myspace" },
  { table: "content_items", column: "status", bogus: "publishd" },
  { table: "content_items", column: "origin", bogus: "robot" },
  { table: "adaptations", column: "status", bogus: "awaiting_review" },
  { table: "adaptations", column: "origin", bogus: "robot" },
  { table: "publications", column: "status", bogus: "inflight" },
  { table: "ai_credentials", column: "provider", bogus: "acme_ai" },
  { table: "content_versions", column: "origin", bogus: "robot" },
  { table: "content_versions", column: "scope", bogus: "partial" },
  { table: "pipeline_runs", column: "status", bogus: "awaiting_review" },
  { table: "usage_ledger", column: "provider", bogus: "acme_ai" },
  { table: "usage_ledger", column: "cost_source", bogus: "guessed" },
  { table: "usage_ledger", column: "status", bogus: "OK" },
  { table: "usage_ledger", column: "key_ownership", bogus: "ours" },
  // 0012's, and nullable — which the CHECK admits (`NULL in (…)` is NULL) while
  // still refusing a misspelling. A value outside the set would read as
  // `completed` to both readers of the ledger: silently free.
  { table: "usage_ledger", column: "outcome", bogus: "unkown" },
];

/** Postgres SQLSTATEs the assertions below name rather than match by message. */
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

/**
 * One row in every table 0009 touches, written with SQL that is valid at 0008
 * AND at head — 0009 adds no columns, which is what lets the same seed prove
 * both "the constraints can be added over real data" and "the constraints
 * refuse the rows they exist to refuse".
 */
async function seedEveryTable(pool: pg.Pool, org: string) {
  await pool.query("INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)", [org]);
  const brand = await pool.query(
    "INSERT INTO brands (org_id, name) VALUES ($1, 'Brand') RETURNING id",
    [org],
  );
  const brandId = brand.rows[0].id as string;
  const channel = await pool.query(
    "INSERT INTO channels (org_id, brand_id, platform, name, credentials_encrypted) VALUES ($1, $2, 'telegram', 'Announcements', 'blob') RETURNING id",
    [org, brandId],
  );
  const channelId = channel.rows[0].id as string;
  const item = await pool.query(
    "INSERT INTO content_items (org_id, brand_id, body, status, origin) VALUES ($1, $2, 'Ship it.', 'draft', 'ai') RETURNING id",
    [org, brandId],
  );
  const itemId = item.rows[0].id as string;
  const adaptation = await pool.query(
    "INSERT INTO adaptations (org_id, content_item_id, channel_id, status, origin) VALUES ($1, $2, $3, 'pending', 'ai') RETURNING id",
    [org, itemId, channelId],
  );
  const adaptationId = adaptation.rows[0].id as string;
  await pool.query(
    "INSERT INTO publications (org_id, adaptation_id, channel_id, status) VALUES ($1, $2, $3, 'failed')",
    [org, adaptationId, channelId],
  );
  await pool.query(
    "INSERT INTO ai_credentials (org_id, provider, credentials_encrypted) VALUES ($1, 'google', 'blob')",
    [org],
  );
  const run = await pool.query(
    `INSERT INTO pipeline_runs (org_id, brand_id, input, status) VALUES ($1, $2, $3, 'succeeded') RETURNING id`,
    [org, brandId, JSON.stringify({ kind: "brief", text: "a brief", channelIds: [channelId] })],
  );
  await pool.query(
    `INSERT INTO usage_ledger (org_id, run_id, step, provider, model_id, cost_usd, cost_source, status, key_ownership)
       VALUES ($1, $2, 'writer', 'google', 'gemini-3-flash', 0.001234, 'price_table', 'ok', 'byok')`,
    [org, run.rows[0].id],
  );
  await pool.query(
    "INSERT INTO content_versions (org_id, content_item_id, adaptation_id, body, origin, scope) VALUES ($1, $2, $3, 'the first draft', 'ai', 'full')",
    [org, itemId, adaptationId],
  );
  await pool.query(
    "INSERT INTO content_versions (org_id, content_item_id, body, origin, scope) VALUES ($1, $2, 'the master draft', 'ai', 'full')",
    [org, itemId],
  );
  return { brandId, channelId, itemId, adaptationId };
}

/**
 * Every row of every table 0009 touches, ordered so two reads are comparable.
 * `SELECT *` deliberately: the point is that NOTHING changed, and an explicit
 * column list would quietly stop looking at whatever it forgot.
 */
async function snapshotRows(pool: pg.Pool): Promise<Record<string, pg.QueryResultRow[]>> {
  const snapshot: Record<string, pg.QueryResultRow[]> = {};
  for (const table of [
    "brands",
    "channels",
    "content_items",
    "adaptations",
    "publications",
    "ai_credentials",
    "pipeline_runs",
    "usage_ledger",
    "content_versions",
  ]) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
    snapshot[table] = rows;
  }
  return snapshot;
}

/**
 * Every value a row held before the migrations is still exactly that value
 * after them, and any column the migrations ADDED is null on every pre-existing
 * row.
 *
 * A plain `toEqual` of the two snapshots said the same thing while 0009 was the
 * only migration under test — it adds no columns, which is what let one seed
 * prove both halves. It stops being usable the moment a LATER migration adds
 * one (0011 adds `publications.channel_name` / `channel_platform`): every row
 * of that table grows a key the seed could not have had, and the whole
 * assertion fails for a reason that has nothing to do with rewriting data.
 *
 * Weakening it to a column subset would have given that away. So the property
 * is split instead, and it is now the stronger of the two: no seeded value may
 * change, AND a new column must arrive empty on rows that predate it. A
 * migration that BACKFILLS over live rows fails the second half — which is
 * precisely the class this test exists to catch, and which the old shape could
 * only catch for migrations that added no columns at all.
 */
function expectNoRowRewritten(
  after: Record<string, pg.QueryResultRow[]>,
  before: Record<string, pg.QueryResultRow[]>,
): void {
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const [table, beforeRows] of Object.entries(before)) {
    const afterRows = after[table] as pg.QueryResultRow[];
    expect(afterRows, `${table}: row count changed`).toHaveLength(beforeRows.length);
    beforeRows.forEach((beforeRow, i) => {
      const afterRow = afterRows[i] as pg.QueryResultRow;
      const seededKeys = Object.keys(beforeRow);
      expect(
        Object.fromEntries(seededKeys.map((key) => [key, afterRow[key]])),
        `${table}: an existing value was rewritten`,
      ).toEqual(beforeRow);
      const added = Object.keys(afterRow).filter((key) => !seededKeys.includes(key));
      expect(
        added.filter((key) => afterRow[key] !== null),
        `${table}: a column added after the seed was backfilled over an existing row`,
      ).toEqual([]);
    });
  }
}

/**
 * Every message in an error's `cause` chain, plus any Postgres `hint`.
 *
 * drizzle wraps a failed statement in a `DrizzleQueryError` whose own message
 * is the SQL it tried to run; the database's own words — which is what the
 * preflight exists to produce — are one or more `cause` levels down. Asserting
 * on `error.message` alone would pass over an empty preflight, because the SQL
 * text quoted in the wrapper contains the RAISE literals too.
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    const pgError = current as Error & { hint?: string };
    parts.push(pgError.message);
    if (typeof pgError.hint === "string") parts.push(pgError.hint);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

/** The SQLSTATE of a rejected write, or null if Postgres accepted it. */
async function refusal(pool: pg.Pool, text: string, values: unknown[] = []) {
  try {
    await pool.query(text, values);
    return null;
  } catch (error) {
    return (error as { code?: string; message: string }).code ?? (error as Error).message;
  }
}

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

  /**
   * The exploit, refused. Two adaptations for one channel are not a duplicate
   * record — they are a second post: `approve` locks every adaptation of the
   * item in `pending | failed | scheduled` and enqueues one publish job per
   * row, and the `publications` in-flight and published indexes are both scoped
   * to ONE adaptation, so neither can see the pair. Measured before the index
   * existed: the duplicate row was accepted, approve enqueued two live publish
   * jobs under one channel's group, and both would have sent.
   */
  it("admits one undelivered adaptation per item and channel, and refuses a second", async () => {
    const fresh = await withFreshDatabase(url as string);
    try {
      await runMigrations(fresh.url);
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const seed = await seedEveryTable(pool, "org_one_live");
        const duplicate = await refusal(
          pool,
          "INSERT INTO adaptations (org_id, content_item_id, channel_id) VALUES ('org_one_live', $1, $2)",
          [seed.itemId, seed.channelId],
        );
        expect(duplicate).toBe(UNIQUE_VIOLATION);

        // A DIFFERENT channel of the same item is the ordinary fan-out and must
        // stay ordinary — an index that also refused this would have broken
        // every multi-channel post rather than the exploit.
        const second = await pool.query(
          "INSERT INTO channels (org_id, brand_id, platform, name, credentials_encrypted) VALUES ('org_one_live', $1, 'vk', 'Wall', 'blob') RETURNING id",
          [seed.brandId],
        );
        expect(
          await refusal(
            pool,
            "INSERT INTO adaptations (org_id, content_item_id, channel_id) VALUES ('org_one_live', $1, $2)",
            [seed.itemId, second.rows[0].id],
          ),
        ).toBeNull();

        // And the same channel on a DIFFERENT item: two posts to one channel is
        // what a content calendar IS.
        const otherItem = await pool.query(
          "INSERT INTO content_items (org_id, brand_id, body) VALUES ('org_one_live', $1, 'Another one.') RETURNING id",
          [seed.brandId],
        );
        expect(
          await refusal(
            pool,
            "INSERT INTO adaptations (org_id, content_item_id, channel_id) VALUES ('org_one_live', $1, $2)",
            [otherItem.rows[0].id, seed.channelId],
          ),
        ).toBeNull();
      } finally {
        await pool.end();
      }
    } finally {
      await fresh.drop();
    }
  });

  /**
   * The predicate, from the side that matters for increment 2c. A published
   * adaptation is history rather than a delivery — the one status `approve`
   * never re-enqueues — so re-adapting that channel may write a fresh live row
   * beside it. This is the assertion that says the planned feature does not
   * have to drop the index; if someone narrows the predicate to a list of
   * statuses, this is what fails.
   */
  it("lets a re-adaptation join a published row, and still refuses two live ones", async () => {
    const fresh = await withFreshDatabase(url as string);
    try {
      await runMigrations(fresh.url);
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const seed = await seedEveryTable(pool, "org_readapt");
        await pool.query("UPDATE adaptations SET status = 'published' WHERE id = $1", [
          seed.adaptationId,
        ]);
        const readapted = await pool.query(
          "INSERT INTO adaptations (org_id, content_item_id, channel_id) VALUES ('org_readapt', $1, $2) RETURNING id",
          [seed.itemId, seed.channelId],
        );
        expect(readapted.rows).toHaveLength(1);
        // Two published rows are two deliveries that already happened, which is
        // history and not a race; the live one is still unique.
        expect(
          await refusal(
            pool,
            "INSERT INTO adaptations (org_id, content_item_id, channel_id) VALUES ('org_readapt', $1, $2)",
            [seed.itemId, seed.channelId],
          ),
        ).toBe(UNIQUE_VIOLATION);
        // `failed` is deliverable — `approve` re-targets it — so the exemption
        // must not extend to it. Written as a status change on the live row
        // rather than a new insert: the constraint has to hold across UPDATEs.
        expect(
          await refusal(pool, "UPDATE adaptations SET status = 'failed' WHERE id = $1", [
            seed.adaptationId,
          ]),
        ).toBe(UNIQUE_VIOLATION);
      } finally {
        await pool.end();
      }
    } finally {
      await fresh.drop();
    }
  });

  /**
   * The composite foreign key. A version row filing one item's id against
   * another item's adaptation is not rejected by anything else: both columns
   * point at rows that exist, and the pair is what is wrong. What it produces
   * downstream is a quiet wrong answer rather than a crash — the row is grouped
   * under an adaptation the item does not have, the real adaptation is left
   * with no `ai` evidence, and the publish gate refuses a draft a human wrote.
   */
  it("refuses a version row whose adaptation belongs to another item", async () => {
    const fresh = await withFreshDatabase(url as string);
    try {
      await runMigrations(fresh.url);
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const mine = await seedEveryTable(pool, "org_versions");
        const otherItem = await pool.query(
          "INSERT INTO content_items (org_id, brand_id, body) VALUES ('org_versions', $1, 'Another one.') RETURNING id",
          [mine.brandId],
        );
        expect(
          await refusal(
            pool,
            "INSERT INTO content_versions (org_id, content_item_id, adaptation_id, body, origin) VALUES ('org_versions', $1, $2, 'text', 'ai')",
            [otherItem.rows[0].id, mine.adaptationId],
          ),
        ).toBe(FOREIGN_KEY_VIOLATION);
        // MATCH SIMPLE: a master-level row names no adaptation and is left
        // alone. Without that this one foreign key could not serve both levels.
        expect(
          await refusal(
            pool,
            "INSERT INTO content_versions (org_id, content_item_id, body, origin) VALUES ('org_versions', $1, 'text', 'ai')",
            [otherItem.rows[0].id],
          ),
        ).toBeNull();
        // The matching pair still writes, and deleting the adaptation still
        // takes its version rows with it — `ON DELETE CASCADE` on both
        // references, so the composite one did not change what a delete does.
        expect(
          await refusal(
            pool,
            "INSERT INTO content_versions (org_id, content_item_id, adaptation_id, body, origin) VALUES ('org_versions', $1, $2, 'text', 'human')",
            [mine.itemId, mine.adaptationId],
          ),
        ).toBeNull();
        await pool.query("DELETE FROM adaptations WHERE id = $1", [mine.adaptationId]);
        const left = await pool.query(
          "SELECT adaptation_id FROM content_versions WHERE content_item_id = $1",
          [mine.itemId],
        );
        expect(left.rows).toEqual([{ adaptation_id: null }]);
      } finally {
        await pool.end();
      }
    } finally {
      await fresh.drop();
    }
  });

  /**
   * Every pinned column, refusing a value outside its set — the assertion that
   * the fourteen constraints reached the database rather than only the schema
   * module. Driven from `PINNED_COLUMNS` so a column added there without a
   * migration fails here.
   */
  it("refuses a value outside the enum on every pinned column", async () => {
    const fresh = await withFreshDatabase(url as string);
    try {
      await runMigrations(fresh.url);
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        await seedEveryTable(pool, "org_enums");
        const accepted: string[] = [];
        for (const { table, column, bogus } of PINNED_COLUMNS) {
          const code = await refusal(pool, `UPDATE ${table} SET ${column} = '${bogus}'`);
          if (code !== CHECK_VIOLATION) accepted.push(`${table}.${column} -> ${code}`);
        }
        expect(
          accepted,
          "Column that accepted a value outside its enum (or failed for another reason):",
        ).toEqual([]);
        // The seed itself proves the constraints admit every LEGAL value: it
        // wrote one row per table through these same columns, above.
        const rows = await pool.query("SELECT count(*)::int AS n FROM adaptations");
        expect(rows.rows[0].n).toBe(1);
      } finally {
        await pool.end();
      }
    } finally {
      await fresh.drop();
    }
  });

  /**
   * The migration over REAL DATA, which is the only version of "it applies"
   * worth having: a constraint that cannot be added to the rows a running
   * deployment already holds is not a constraint, it is a boot failure. Every
   * table 0009 touches is populated at the pre-0009 schema first, and every row
   * is compared field for field afterwards — `ALTER TABLE ... ADD CONSTRAINT`
   * and `CREATE UNIQUE INDEX` rewrite nothing, and this is the assertion that
   * says so rather than assuming it.
   *
   * `runMigrations` applies everything from 0009 to head, so the claim is
   * really about all of them: see `expectNoRowRewritten` for why the comparison
   * is not a flat `toEqual` of the two snapshots any more.
   */
  it("adds the invariants to a database that already holds rows of every table", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(CONSTRAINT_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seeded: Record<string, pg.QueryResultRow[]>;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        // If the constraints were already here, "seeded before the migration"
        // would be a lie and the assertions below would prove nothing.
        const pre = await pool.query(
          "SELECT conname FROM pg_constraint WHERE conname LIKE '%\\_check' AND connamespace = 'public'::regnamespace",
        );
        expect(pre.rows).toHaveLength(0);
        await seedEveryTable(pool, "org_populated");
        seeded = await snapshotRows(pool);
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      const rows = await snapshotRows(after);
      const constraints = await after.query(
        "SELECT conname FROM pg_constraint WHERE conname LIKE '%\\_check' AND connamespace = 'public'::regnamespace",
      );
      const index = await after.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'adaptations_one_live_per_item_channel'",
      );
      await after.end();

      expectNoRowRewritten(rows, seeded);
      expect(constraints.rows).toHaveLength(PINNED_COLUMNS.length);
      expect(index.rows[0]?.indexdef).toContain("WHERE (status <> 'published'::text)");
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  /**
   * 0012 lands a nullable column and a CHECK on a table whose whole point is
   * that it is written to constantly. Two claims, both of which have to hold on
   * a database that already holds ledger rows.
   *
   * ROWS WRITTEN BEFORE IT KEEP THE MEANING THEY HAD. They come back with
   * `outcome` NULL, which both readers treat as `completed` — the reading those
   * rows already got. Back-filling `unknown` instead would stamp "≥" on every
   * existing org's lifetime total for a blip that may well have been a 429, and
   * nothing can retroactively learn which it was.
   *
   * AND THE CHECK ADMITS THEM. `NULL in (…)` evaluates to NULL and a CHECK
   * admits NULL, which is what lets a constraint arrive on a nullable column
   * with no preflight and no back-fill — while still refusing a misspelling
   * that would read as `completed` to every reader.
   */
  it("adds the ledger's outcome to a populated table without touching a row", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(OUTCOME_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seeded: pg.QueryResultRow[];
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        // If the column were already here, "written before the migration" would
        // be a lie and everything below would prove nothing.
        const pre = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_ledger' AND column_name = 'outcome'",
        );
        expect(pre.rows).toHaveLength(0);

        await seedEveryTable(pool, "org_outcome");
        // A second row, of the kind this column exists to disambiguate: zero
        // tokens, no cost, errored — a 429 and a lost generation are the same
        // four columns until `outcome` tells them apart.
        await pool.query(
          `INSERT INTO usage_ledger (org_id, step, provider, model_id, cost_usd, cost_source, status)
             VALUES ('org_outcome', 'writer', 'google', 'gemini-3-flash', NULL, 'unknown', 'errored')`,
        );
        seeded = (await pool.query("SELECT * FROM usage_ledger ORDER BY id")).rows;
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      const rows = await after.query("SELECT * FROM usage_ledger ORDER BY id");
      const column = await after.query(
        "SELECT is_nullable, data_type, column_default FROM information_schema.columns WHERE table_name = 'usage_ledger' AND column_name = 'outcome'",
      );
      const refusedBogus = await refusal(
        after,
        `INSERT INTO usage_ledger (org_id, step, provider, model_id, cost_source, status, outcome)
           VALUES ('org_outcome', 'writer', 'google', 'gemini-3-flash', 'unknown', 'errored', 'unkown')`,
      );
      const acceptedReal = await refusal(
        after,
        `INSERT INTO usage_ledger (org_id, step, provider, model_id, cost_source, status, outcome)
           VALUES ('org_outcome', 'writer', 'google', 'gemini-3-flash', 'unknown', 'errored', 'unknown')`,
      );
      await after.end();

      expect(rows.rows).toEqual(seeded.map((row) => ({ ...row, outcome: null })));
      expect(column.rows[0]).toMatchObject({
        is_nullable: "YES",
        data_type: "text",
        column_default: null,
      });
      expect(refusedBogus).toBe(CHECK_VIOLATION);
      expect(acceptedReal).toBeNull();
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  /**
   * The preflight, doing the one thing it exists for. Postgres reports a check
   * violation on an existing row as `check constraint "x" of relation "y" is
   * violated by some row` — it names neither the row nor the value, and a
   * self-hoster reading that at boot has nothing to query for. The migration
   * therefore scans first and raises a message naming the table, the column and
   * the offending values.
   *
   * The row is planted at the pre-0009 schema, where nothing yet forbids it —
   * which is also the honest reproduction of how such a row gets into a real
   * database in the first place.
   */
  it("names the table, column and value when an existing row is outside the enum", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(CONSTRAINT_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await seedEveryTable(pool, "org_typo");
        await pool.query("UPDATE adaptations SET status = 'publishd'");
      } finally {
        await pool.end();
      }

      const failure = await runMigrations(fresh.url).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, "the migration applied over a row outside the enum").not.toBeNull();
      // The database's own sentence, not drizzle's wrapper — see `messageChain`.
      // Postgres' unaided report is `check constraint "x" of relation "y" is
      // violated by some row`, which names neither the row nor the value.
      const said = messageChain(failure);
      expect(said).toContain("Cannot pin adaptations.status");
      expect(said).toContain("'publishd'");
      // The HINT carries the set the operator has to choose from, so the fix
      // does not require reading the migration.
      expect(said).toContain("pending, scheduled, queued, publishing, published, failed");

      // And it rolled back whole: drizzle runs every pending migration in one
      // transaction, so a raised preflight must leave NO constraint behind.
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      const left = await after.query(
        "SELECT conname FROM pg_constraint WHERE conname LIKE '%\\_check' AND connamespace = 'public'::regnamespace",
      );
      await after.end();
      expect(left.rows).toEqual([]);
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });
});
