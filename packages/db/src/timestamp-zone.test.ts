import { randomUUID } from "node:crypto";
import { getTableColumns, is, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "./index.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;

/**
 * The zone every assertion below runs in, and it is NOT UTC on purpose.
 *
 * A `timestamp` column that stores an instant agrees with everything around it
 * for exactly as long as the session that reads it keeps the same clock the
 * session that wrote it kept. The project's own compose file pins Postgres to
 * UTC, so every one of these assertions is trivially true there — which is
 * precisely how the defect survived: a suite that only ever ran under UTC could
 * not tell a zone-independent column from a zone-dependent one.
 *
 * `Asia/Tokyo` rather than a fixed `+09`: it is a real, DST-free zone, so the
 * offset is stable enough for arithmetic assertions while still being a
 * different clock from the one the values are written in.
 */
const OTHER_ZONE = "Asia/Tokyo";

/** How far off UTC `OTHER_ZONE` is. Nine hours, in milliseconds. */
const OTHER_ZONE_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * Tables whose every timestamp column must carry its zone, and why each one is
 * in the list rather than the list being "all of them".
 *
 * These are the tables of the publishing path — the ones `apps/api/src/content`
 * and `apps/worker/src/publish` write, and the ones whose timestamps are
 * written by TWO clocks at once: the api and the worker send a JavaScript
 * `Date` (a UTC wall clock, whatever the database's zone), while `defaultNow()`
 * and the worker's `nowSql()` send Postgres's `now()` (the SESSION's wall
 * clock). Stored without a zone those are the same number only on a UTC
 * database.
 */
const ZONED_TABLES = [
  "brands",
  "channels",
  "content_items",
  "adaptations",
  "publications",
  "content_versions",
] as const;

/**
 * The timestamp columns deliberately left without a zone, with the reason for
 * each — asserted rather than skipped, exactly as `UNPINNED_BY_DESIGN` is in
 * `schema-invariants.test.ts`: leaving a column behind is a decision, and a
 * decision belongs in a test that fails when somebody quietly reverses it.
 *
 * - **better-auth's seven tables.** Their columns are not ours. better-auth
 *   writes and reads every one of them through its own drizzle adapter, as a
 *   JavaScript `Date` on both sides, so they round-trip through drizzle's
 *   "naive means UTC" convention and back with no second clock anywhere near
 *   them: nothing in this repository stamps one with `now()` and nothing
 *   compares one against `now()`. The mixed-clock exposure this file exists to
 *   close does not exist there, and changing the storage of a dependency's
 *   tables to fix a defect they do not have is not a trade worth making.
 *
 * - **`ai_credentials`, `pipeline_runs` and `usage_ledger`.** These DO have the
 *   exposure — `pipeline_runs.created_at`/`updated_at` reach a browser, and
 *   `lease_expires_at` and `usage_ledger.created_at` are compared against
 *   `now()` — and they are left only because the prose that argues for the
 *   `now()`-in-SQL writes lives in `apps/worker/src/generate` and
 *   `apps/api/src/ai-credentials`, which this change does not own. Converting
 *   the columns while leaving those comments saying "`timestamp` WITHOUT time
 *   zone" behind would put the schema and its stated reasoning in
 *   contradiction, which is worse than a gap that is written down. This entry
 *   is the writing-down.
 */
const UNZONED_BY_DESIGN: ReadonlyArray<{ table: string; reason: string }> = [
  { table: "user", reason: "better-auth's table: JavaScript Date on both sides, no now() writer" },
  { table: "session", reason: "better-auth's table" },
  { table: "account", reason: "better-auth's table" },
  { table: "verification", reason: "better-auth's table" },
  { table: "organization", reason: "better-auth's table" },
  { table: "member", reason: "better-auth's table" },
  { table: "invitation", reason: "better-auth's table" },
  { table: "ai_credentials", reason: "reasoning lives in apps/api/src/ai-credentials" },
  { table: "pipeline_runs", reason: "reasoning lives in apps/worker/src/generate" },
  { table: "usage_ledger", reason: "reasoning lives in apps/worker/src/generate" },
];

/** Every timestamp column this package declares, and whether it carries a zone. */
const timestampColumns = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .flatMap((table) => {
    const name = getTableConfig(table).name;
    return (
      Object.values(getTableColumns(table))
        .map((column) => ({ table: name, column: column.name, sqlType: column.getSQLType() }))
        // By the SQL type rather than by `is(column, PgTimestamp)`: the class is
        // generic, and the question being asked is what reaches the database.
        .filter((column) => column.sqlType.startsWith("timestamp"))
        .map((column) => ({ ...column, zoned: column.sqlType.includes("with time zone") }))
    );
  });

/**
 * A database of this file's own, migrated to head.
 *
 * Not the shared `TEST_DATABASE_URL`, for a reason that showed up as a
 * `40P01`: the migration suite runs `runMigrations` against that database, and
 * `0014`'s `ALTER TABLE`s take an ACCESS EXCLUSIVE lock on the same tables
 * these assertions insert into. Two suites in one file run then deadlock over
 * the schema rather than over anything either of them is testing. A private
 * database also means the rows below are nobody else's residue.
 */
let ownDatabase: { url: string; drop: () => Promise<void> } | undefined;
const pools: pg.Pool[] = [];

/**
 * A pool on that database whose every connection runs in `OTHER_ZONE`.
 *
 * The zone is set as a libpq startup option rather than with a `SET TIME ZONE`
 * statement, so it applies to every connection the pool opens — including the
 * one a later query happens to land on — instead of to whichever connection the
 * setter borrowed.
 */
function zonedPool(): pg.Pool {
  const pool = new pg.Pool({
    connectionString: (ownDatabase as { url: string }).url,
    options: `-c timezone=${OTHER_ZONE}`,
  });
  pools.push(pool);
  return pool;
}

/**
 * The throwaway databases this file makes, and the millisecond stamp in each
 * name — the same shape, and the same reason, as `migrate.test.ts`'s
 * `pubrick_fresh_*`. `afterAll` runs from a failing assertion but not from a
 * killed process, so a Ctrl-C or a vitest timeout leaks one per run; creation
 * therefore sweeps whatever the last dead run left. The window is far longer
 * than any run of this suite, so the sweep can never take a database a
 * CONCURRENT run is still using — `WITH (FORCE)` would kill its connections
 * mid-migration.
 */
const ZONE_DATABASE = /^pubrick_zone_(\d+)_\d+$/;
const STALE_AFTER_MS = 60 * 60 * 1000;

/** Drops what a killed run left behind. Never throws: a leftover we could not
 * drop is a leftover, and the test it would have tidied up for is none the
 * worse for it. */
async function dropStaleDatabases(admin: pg.Client): Promise<void> {
  try {
    const { rows } = await admin.query<{ datname: string }>("SELECT datname FROM pg_database");
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const { datname } of rows) {
      const stamp = ZONE_DATABASE.exec(datname);
      if (stamp === null || Number(stamp[1]) > cutoff) continue;
      // Interpolated, but only ever a name this regex just matched: the literal
      // prefix and digits, so there is nothing here to quote out of.
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } catch {
    // See above.
  }
}

beforeAll(async () => {
  if (!url) return;
  const name = `pubrick_zone_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await dropStaleDatabases(admin);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const fresh = new URL(url);
  fresh.pathname = `/${name}`;
  ownDatabase = {
    url: fresh.toString(),
    drop: async () => {
      const cleanup = new pg.Client({ connectionString: url });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
  await runMigrations(ownDatabase.url);
}, 60_000);

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await ownDatabase?.drop();
});

/** The single row a query below must have returned, without an optional chain
 * that would turn a missing row into a passing assertion. */
function only<T extends pg.QueryResultRow>(result: pg.QueryResult<T>): T {
  expect(result.rows, "expected exactly one row").toHaveLength(1);
  return result.rows[0] as T;
}

/** One org, brand, channel and item, and one adaptation on it. Raw SQL, so the
 * seed says nothing about how the columns under test are mapped. */
async function seedAdaptation(pool: pg.Pool) {
  const org = `tz-${randomUUID()}`;
  await pool.query("INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)", [org]);
  const brand = await pool.query(
    "INSERT INTO brands (org_id, name) VALUES ($1, 'Brand') RETURNING id",
    [org],
  );
  const brandId = brand.rows[0].id as string;
  const channel = await pool.query(
    "INSERT INTO channels (org_id, brand_id, platform, name, credentials_encrypted) VALUES ($1, $2, 'telegram', 'Main', 'blob') RETURNING id",
    [org, brandId],
  );
  const item = await pool.query(
    "INSERT INTO content_items (org_id, brand_id, body) VALUES ($1, $2, 'Ship it.') RETURNING id",
    [org, brandId],
  );
  const adaptation = await pool.query(
    "INSERT INTO adaptations (org_id, content_item_id, channel_id) VALUES ($1, $2, $3) RETURNING id",
    [org, item.rows[0].id, channel.rows[0].id],
  );
  return { org, itemId: item.rows[0].id as string, adaptationId: adaptation.rows[0].id as string };
}

describe("timestamps carry their zone", () => {
  it("declares every publishing-path timestamp with a zone", () => {
    const onThePath = timestampColumns.filter((column) =>
      ZONED_TABLES.includes(column.table as (typeof ZONED_TABLES)[number]),
    );
    // Non-vacuity first: a misspelled table name in `ZONED_TABLES`, or a table
    // dropped from it, would leave the assertion below true of nothing.
    expect(onThePath.map((column) => `${column.table}.${column.column}`).sort()).toEqual([
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
    ]);
    const unzoned = onThePath
      .filter((column) => !column.zoned)
      .map((column) => `${column.table}.${column.column}`);
    expect(unzoned, "a publishing-path timestamp column has no time zone").toEqual([]);
  });

  it("accounts for every timestamp column that is still without a zone", () => {
    // The other half, and the half that makes the list above mean something: a
    // column left unzoned must be in a table somebody decided to leave, with a
    // reason written next to it. A NEW table full of naive timestamps fails
    // here rather than sliding in behind the list above.
    const left = new Set(UNZONED_BY_DESIGN.map((entry) => entry.table));
    const undeclared = timestampColumns
      .filter((column) => !column.zoned && !left.has(column.table))
      .map((column) => `${column.table}.${column.column}`);
    expect(undeclared, "a timestamp column has neither a zone nor a reason").toEqual([]);
    for (const entry of UNZONED_BY_DESIGN) {
      expect(entry.reason.length, `${entry.table} was left with no reason`).toBeGreaterThan(0);
    }
  });

  describe.skipIf(!url)("against a session that is not in UTC", () => {
    it("is really running in another zone", async () => {
      // The guard on everything below. Under UTC every one of these assertions
      // passes whether the columns carry a zone or not, so a session that
      // silently fell back to UTC would turn this whole file green and blind.
      const pool = zonedPool();
      const session = await pool.query<{ TimeZone: string }>("SHOW timezone");
      expect(only(session).TimeZone).toBe(OTHER_ZONE);
      const offset = await pool.query<{ ms: string }>(
        "SELECT (extract(epoch from (now()::timestamp - now() at time zone 'UTC')) * 1000)::bigint::text AS ms",
      );
      expect(Number(only(offset).ms)).toBe(OTHER_ZONE_OFFSET_MS);
    });

    it("agrees with the database that a post scheduled an hour out is in the future", async () => {
      // THE DEFECT, stated as the database's own opinion of the row.
      //
      // `scheduled_at` is written from a JavaScript `Date` — the instant the
      // browser picked. Stored without a zone it lands as a UTC wall clock,
      // while `now()` on this session reads nine hours ahead of it, so a post
      // scheduled one hour from now is EIGHT HOURS IN THE PAST as far as any
      // SQL that looks at the column is concerned. Nothing about that is
      // visible from the api, which reads the column back through the same
      // UTC-assuming mapping that wrote it and reports the time the user asked
      // for.
      const pool = zonedPool();
      const db = drizzle(pool, { schema });
      const { adaptationId } = await seedAdaptation(pool);
      const when = new Date(Date.now() + 60 * 60 * 1000);

      await db
        .update(schema.adaptations)
        .set({ status: "scheduled", scheduledAt: when })
        .where(sql`${schema.adaptations.id} = ${adaptationId}`);

      const verdict = await pool.query<{ future: boolean; minutes: string }>(
        `SELECT scheduled_at > now() AS future,
                (extract(epoch from (scheduled_at - now())) / 60)::int::text AS minutes
           FROM adaptations WHERE id = $1`,
        [adaptationId],
      );
      const read = only(verdict);
      expect(read.future, "the database reads a future schedule as past").toBe(true);
      expect(Number(read.minutes)).toBeGreaterThan(55);
      expect(Number(read.minutes)).toBeLessThanOrEqual(60);
    });

    it("keeps a row's own columns on one clock, whoever stamped them", async () => {
      // `created_at` is written by the DATABASE (`defaultNow()`); `scheduled_at`
      // is written by the API, from JavaScript. Without a zone those are two
      // different clocks nine hours apart, so a post scheduled an hour after it
      // was created appears to have been scheduled eight hours BEFORE it — an
      // ordering no reader of this table would ever suspect.
      const pool = zonedPool();
      const db = drizzle(pool, { schema });
      const { adaptationId } = await seedAdaptation(pool);

      await db
        .update(schema.adaptations)
        .set({ scheduledAt: new Date(Date.now() + 60 * 60 * 1000) })
        .where(sql`${schema.adaptations.id} = ${adaptationId}`);

      const gap = await pool.query<{ minutes: string }>(
        `SELECT (extract(epoch from (scheduled_at - created_at)) / 60)::int::text AS minutes
           FROM adaptations WHERE id = $1`,
        [adaptationId],
      );
      const minutes = Number(only(gap).minutes);
      expect(minutes).toBeGreaterThan(55);
      expect(minutes).toBeLessThanOrEqual(61);
    });

    it("hands a reader back the instant the database stamped, not a wall clock", async () => {
      // The other direction: a column the DATABASE writes and a BROWSER reads.
      // drizzle maps a zoneless value as if it were UTC, so on a database whose
      // session is not UTC every `created_at` the api returns is off by the
      // offset — nine hours here — while looking perfectly well-formed.
      const pool = zonedPool();
      const db = drizzle(pool, { schema });
      const { itemId } = await seedAdaptation(pool);

      const rows = await db
        .select({ createdAt: schema.contentItems.createdAt })
        .from(schema.contentItems)
        .where(sql`${schema.contentItems.id} = ${itemId}`);

      expect(rows).toHaveLength(1);
      const createdAt = (rows[0] as { createdAt: Date }).createdAt;
      expect(Math.abs(createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    });

    it("stamps first_opened_at from JavaScript and reads it back as the same instant in SQL", async () => {
      // The publish gate's read receipt: written by the api as a `Date`, and the
      // only column of its table a human's "has anyone read this?" is answered
      // from. Nothing compares it today, which is exactly why it would have
      // rotted quietly.
      const pool = zonedPool();
      const db = drizzle(pool, { schema });
      const { itemId } = await seedAdaptation(pool);
      const opened = new Date(Date.now() - 5_000);

      await db
        .update(schema.contentItems)
        .set({ firstOpenedAt: opened })
        .where(sql`${schema.contentItems.id} = ${itemId}`);

      const seconds = await pool.query<{ ago: string }>(
        `SELECT (extract(epoch from (now() - first_opened_at)))::int::text AS ago
           FROM content_items WHERE id = $1`,
        [itemId],
      );
      const ago = Number(only(seconds).ago);
      expect(ago).toBeGreaterThanOrEqual(4);
      expect(ago).toBeLessThan(60);
    });
  });
});
