import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;

/**
 * READ A ZONELESS `timestamp` AS UTC, the way every other reader in this
 * codebase does.
 *
 * The queries in this file go through raw `pg`, and raw `pg` parses a value
 * from a column with no time zone by building a `Date` **in the Node process's
 * own zone** — so on a developer machine in Europe/Moscow a row stamped
 * `15:38` by the database comes back as `12:38Z`, three hours from where it
 * actually is. drizzle, which is how the api and the worker read the same
 * columns, replaces that parser and reads the value as UTC.
 *
 * That did not matter while every timestamp column was zoneless: both snapshots
 * of a before/after comparison were taken through the same wrong lens and
 * cancelled out. `0014` gives the publishing path's columns a zone, so the
 * "after" read is now correct while the "before" read is not, and
 * `expectNoRowRewritten` would report a value as rewritten when nothing about
 * it moved. Aligning the raw reader with drizzle compares the two ends on one
 * clock — and the remaining zoneless columns (`pipeline_runs`, `usage_ledger`,
 * `ai_credentials`, better-auth's tables) are read here the way the product
 * reads them rather than the way `pg` guesses.
 *
 * Module-global to the `pg` instance this test file loads, which is the whole
 * of its blast radius: vitest gives each file its own module graph, and
 * drizzle's own per-query parsers are unaffected either way. Applied from a
 * `beforeAll` rather than at module scope, because a bare call there is a shape
 * `db-tier.guard.test.ts` refuses: it cannot tell one from a suite registered
 * through a helper.
 */
function readZonelessAsUtc(): void {
  pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (value) => new Date(`${value}Z`));
}

/** The migration whose additivity is proved below, by name rather than by index. */
const ADDITIVE_MIGRATION = "0006_authorship";

/** The index-only migration proved additive AND non-vacuous below. */
const INDEX_MIGRATION = "0007_ledger_draft_index";

/** The constraint-only migration, proved against a populated database below. */
const CONSTRAINT_MIGRATION = "0009_declared_invariants";

/** The migration that gives the publishing path's timestamps a zone. */
const ZONE_MIGRATION = "0014_scheduled_at_carries_its_zone";

/** The migration that gives a refine fragment its `unit_delta`, proved additive below. */
const UNIT_DELTA_MIGRATION = "0015_fragment_unit_delta";

/**
 * Every column 0014 gives a zone to, in the order `information_schema` sorts
 * them. Written out rather than derived from the schema: the point of the
 * assertion is that the DATABASE matches a decision somebody wrote down, and a
 * list computed from the same types the migration was generated from could only
 * ever agree with itself.
 */
const ZONED_COLUMNS = [
  "adaptations.created_at",
  "adaptations.scheduled_at",
  "adaptations.updated_at",
  "brands.created_at",
  "brands.updated_at",
  "channels.created_at",
  "channels.updated_at",
  "content_items.created_at",
  "content_items.first_opened_at",
  "content_items.updated_at",
  "content_versions.created_at",
  "publications.created_at",
];

/**
 * The tables whose timestamps are deliberately still zoneless. The reason for
 * each is argued in `timestamp-zone.test.ts`, which holds the same split
 * against the TYPES; this file holds it against the database.
 */
const UNZONED_TABLES = [
  "account",
  "ai_credentials",
  "invitation",
  "member",
  "organization",
  "pipeline_runs",
  "session",
  "usage_ledger",
  "user",
  "verification",
];

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

/**
 * Every `%_check`-named constraint that is NOT one of `PINNED_COLUMNS` — a
 * value pinned into a relationship with another column rather than into a
 * value set, so it has no single `bogus` scalar the loop above could try. The
 * "adds the invariants to a database that already holds rows of every table"
 * test below counts every `_check` constraint as a proxy for "did the enum
 * constraints reach the database", and that proxy stops being exact the
 * moment a check exists that ISN'T an enum pin — this is where such a check
 * declares itself, so the count stays a count of something rather than a
 * number two lists happen to have summed to once.
 */
const NON_ENUM_CHECKS = [
  // 0015's: non-null exactly when `scope = 'fragment'`. Proved directly by
  // `migrate.test.ts`'s "adds the fragment unit delta..." (both wrong shapes
  // refused, both right ones accepted) — counted here only so THIS test's
  // total stays meaningful rather than one short.
  "content_versions_unit_delta_scope_check",
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
  beforeAll(readZonelessAsUtc);

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
      // Every enum pin PLUS every non-enum check — see `NON_ENUM_CHECKS` for
      // why this is not simply `PINNED_COLUMNS.length` any more.
      expect(constraints.rows).toHaveLength(PINNED_COLUMNS.length + NON_ENUM_CHECKS.length);
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
   * 0015 lands a nullable column and a two-column CHECK on the same table
   * 0012 lands its own on, and the claims are the same shape: rows written
   * before it keep exactly the meaning they had, and the CHECK holds in BOTH
   * directions rather than only admitting the row a happy-path test would
   * think to write.
   *
   * NULL IS WHAT EVERY PRE-EXISTING ROW ALREADY MEANT. `seedEveryTable`
   * writes two `full` rows — a whole body has nothing it "replaced" — and
   * both must come back with `unit_delta` NULL, which the CHECK below
   * REQUIRES of a `full` row rather than merely tolerating.
   *
   * BOTH WRONG SHAPES ARE REFUSED, NOT ONLY ONE. A `fragment` row with no
   * delta and a `full` row carrying one are the two shapes `allSentencesAi`
   * (Task 2) cannot tell apart from honest evidence — see the migration's own
   * header. A test that only planted one of them would leave the other
   * direction of the CHECK unproven, exactly the gap `content_versions
   * .scope`'s own CHECK closed for the value-set case.
   *
   * AND BOTH RIGHT SHAPES STILL WRITE. A CHECK of `false` — or a column that
   * silently failed to reach the database — would also make the two refusals
   * above pass, for the wrong reason; these two inserts are what rules that
   * out.
   */
  it("adds the fragment unit delta to a populated table, and refuses both wrong shapes", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(UNIT_DELTA_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seeded: { itemId: string; rows: pg.QueryResultRow[] };
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        // If the column were already here, "written before the migration"
        // would be a lie and everything below would prove nothing.
        const pre = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'content_versions' AND column_name = 'unit_delta'",
        );
        expect(pre.rows).toHaveLength(0);

        const seed = await seedEveryTable(pool, "org_unit_delta");
        const rows = (await pool.query("SELECT id, body, scope FROM content_versions ORDER BY id"))
          .rows;
        seeded = { itemId: seed.itemId, rows };
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const rows = await after.query(
          "SELECT id, body, scope, unit_delta FROM content_versions ORDER BY id",
        );
        const column = await after.query(
          "SELECT is_nullable, data_type, column_default FROM information_schema.columns WHERE table_name = 'content_versions' AND column_name = 'unit_delta'",
        );
        expect(rows.rows).toEqual(seeded.rows.map((row) => ({ ...row, unit_delta: null })));
        expect(column.rows[0]).toMatchObject({
          is_nullable: "YES",
          data_type: "integer",
          column_default: null,
        });

        // Both wrong shapes: a fragment with no delta, a full row with one.
        const fragmentNoDelta = await refusal(
          after,
          "INSERT INTO content_versions (org_id, content_item_id, body, origin, scope, unit_delta) VALUES ('org_unit_delta', $1, 'a fragment', 'ai', 'fragment', NULL)",
          [seeded.itemId],
        );
        const fullWithDelta = await refusal(
          after,
          "INSERT INTO content_versions (org_id, content_item_id, body, origin, scope, unit_delta) VALUES ('org_unit_delta', $1, 'a whole body', 'ai', 'full', 3)",
          [seeded.itemId],
        );
        expect(fragmentNoDelta).toBe(CHECK_VIOLATION);
        expect(fullWithDelta).toBe(CHECK_VIOLATION);

        // And both right shapes still write.
        const fragmentWithDelta = await refusal(
          after,
          "INSERT INTO content_versions (org_id, content_item_id, body, origin, scope, unit_delta) VALUES ('org_unit_delta', $1, 'a fragment', 'ai', 'fragment', -1)",
          [seeded.itemId],
        );
        const fullNoDelta = await refusal(
          after,
          "INSERT INTO content_versions (org_id, content_item_id, body, origin, scope, unit_delta) VALUES ('org_unit_delta', $1, 'another whole body', 'ai', 'full', NULL)",
          [seeded.itemId],
        );
        expect(fragmentWithDelta).toBeNull();
        expect(fullNoDelta).toBeNull();
      } finally {
        await after.end();
      }
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

  /**
   * WHAT 0014 DOES TO A ROW THAT ALREADY EXISTS — the only question a type
   * change over live data has to answer.
   *
   * The rows are written at the schema as it stood BEFORE 0014, with literal
   * wall clocks rather than `now()`, so what the migration reads them as is a
   * property of the migration and not of when the test ran. They are then
   * migrated **from a session that is not in UTC**, which is the whole point:
   * a bare `ALTER COLUMN ... SET DATA TYPE timestamptz` reads a zoneless value
   * in the session's zone, so on a self-hoster's non-UTC database it would move
   * every scheduled post by the offset. `USING col AT TIME ZONE 'UTC'` reads it
   * as UTC, which is the interpretation drizzle has been applying on every read
   * since these columns existed — so the instant the api served yesterday is
   * the instant it serves today.
   *
   * Both halves are asserted: the value IS the UTC reading, and it is NOT the
   * session's. Only the second one fails if the `USING` clause is dropped, and
   * only on a non-UTC session — which is exactly the test that would not have
   * existed by accident.
   */
  it("reads an existing wall clock as UTC, not as the migrating session's zone", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(ZONE_MIGRATION);
    // Nine hours off UTC and free of DST, so the two readings below are far
    // apart and stay that way whatever date this runs on.
    const zoned = new URL(fresh.url);
    zoned.searchParams.set("options", "-c timezone=Asia/Tokyo");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        const naive = await pool.query<{ data_type: string }>(
          "SELECT data_type FROM information_schema.columns WHERE table_name = 'adaptations' AND column_name = 'scheduled_at'",
        );
        // If the column already carried a zone here, "written before 0014"
        // would be a lie and everything below would prove nothing.
        expect((naive.rows[0] as { data_type: string }).data_type).toBe(
          "timestamp without time zone",
        );
        const seeded = await seedEveryTable(pool, "org_zone");
        await pool.query(
          "UPDATE adaptations SET status = 'scheduled', scheduled_at = TIMESTAMP '2026-03-01 09:30:00' WHERE id = $1",
          [seeded.adaptationId],
        );
        await pool.query(
          "UPDATE content_items SET first_opened_at = TIMESTAMP '2026-02-28 23:45:00' WHERE id = $1",
          [seeded.itemId],
        );
      } finally {
        await pool.end();
      }

      await runMigrations(zoned.toString());

      const after = new pg.Pool({ connectionString: zoned.toString(), max: 1 });
      try {
        // The guard on the two assertions that matter: under UTC they hold
        // whether or not the migration says `AT TIME ZONE 'UTC'`.
        const session = await after.query<{ TimeZone: string }>("SHOW timezone");
        expect(session.rows).toHaveLength(1);
        expect((session.rows[0] as { TimeZone: string }).TimeZone).toBe("Asia/Tokyo");

        const read = await after.query<{ utc: boolean; local: boolean; opened: boolean }>(
          `SELECT a.scheduled_at = TIMESTAMPTZ '2026-03-01 09:30:00+00' AS utc,
                  a.scheduled_at = TIMESTAMPTZ '2026-03-01 09:30:00+09' AS local,
                  i.first_opened_at = TIMESTAMPTZ '2026-02-28 23:45:00+00' AS opened
             FROM adaptations a JOIN content_items i ON i.id = a.content_item_id`,
        );
        expect(read.rows).toHaveLength(1);
        const row = read.rows[0] as { utc: boolean; local: boolean; opened: boolean };
        expect(row.utc, "the stored wall clock was not read as UTC").toBe(true);
        expect(row.local, "the migrating session's zone was used").toBe(false);
        expect(row.opened).toBe(true);
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  /**
   * The end state, over a database holding a row of every affected table:
   * every publishing-path timestamp carries a zone, every deliberately-left one
   * still does not, and nothing was deleted on the way.
   *
   * The negative half is not decoration. A migration written as "convert every
   * timestamp in the schema" would pass the positive half and quietly restate
   * columns whose reasoning lives in packages this change does not own —
   * `packages/db/src/timestamp-zone.test.ts` holds that argument, and this is
   * where it is checked against the database rather than against the types.
   */
  it("gives the publishing path's columns a zone, and only those, over a populated database", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(ZONE_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await seedEveryTable(pool, "org_zone_types");
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const types = await after.query<{ name: string; data_type: string }>(
          `SELECT table_name || '.' || column_name AS name, data_type
             FROM information_schema.columns
            WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'
            ORDER BY name`,
        );
        const zoned = types.rows
          .filter((row) => row.data_type === "timestamp with time zone")
          .map((row) => row.name);
        expect(zoned).toEqual(ZONED_COLUMNS);
        const naive = types.rows
          .filter((row) => row.data_type === "timestamp without time zone")
          .map((row) => row.name.split(".")[0] as string);
        expect(
          [...new Set(naive)].filter((table) => !UNZONED_TABLES.includes(table)),
          "a column outside the declared set was left without a zone",
        ).toEqual([]);

        const counts = await after.query<{ n: string }>(
          "SELECT (SELECT count(*) FROM adaptations) + (SELECT count(*) FROM publications) + (SELECT count(*) FROM content_versions) AS n",
        );
        expect(Number((counts.rows[0] as { n: string }).n)).toBe(4);
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  /**
   * The same end state reached from EVERY version this product has ever been
   * at, not only from the one immediately before 0014.
   *
   * A type change is the migration most likely to depend on the exact shape it
   * starts from — a column that a later migration re-created, a default some
   * intermediate version added — and "it works from 0013" says nothing about a
   * database that has been sitting at 0004 since it was installed. Each cut
   * point is a real database brought to that version and then migrated to head.
   */
  it("reaches the same column types from every earlier version, and from empty", async () => {
    const journal = JSON.parse(
      await fs.readFile(
        path.join(
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations"),
          "meta",
          "_journal.json",
        ),
        "utf8",
      ),
    ) as { entries: { tag: string }[] };

    for (const entry of journal.entries) {
      const fresh = await withFreshDatabase(url as string);
      const before = await migrationsFolderBefore(entry.tag);
      try {
        const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
        try {
          // `0000` cuts to an empty folder, which is the "from empty" case.
          await migrate(drizzle(pool), { migrationsFolder: before });
        } finally {
          await pool.end();
        }

        await runMigrations(fresh.url);

        const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
        try {
          const types = await after.query<{ name: string }>(
            `SELECT table_name || '.' || column_name AS name
               FROM information_schema.columns
              WHERE table_schema = 'public' AND data_type = 'timestamp with time zone'
              ORDER BY name`,
          );
          expect(
            types.rows.map((row) => row.name),
            `starting from ${entry.tag}`,
          ).toEqual(ZONED_COLUMNS);
        } finally {
          await after.end();
        }
      } finally {
        await fs.rm(before, { recursive: true, force: true });
        await fresh.drop();
      }
    }
  }, 180_000);
});
