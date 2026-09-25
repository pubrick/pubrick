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

/**
 * The usage ledger can be large on an existing installation. Drizzle runs SQL
 * migrations inside a transaction, where a regular CREATE INDEX blocks metering
 * writes until commit. Build this index online first, outside that transaction.
 * On a fresh database the table does not exist yet, so migration 0082 creates
 * the index on its empty table instead.
 */
async function prepareUsageHistoryIndex(client: pg.PoolClient): Promise<void> {
  const table = await client.query<{ exists: string | null }>(
    "SELECT to_regclass('public.usage_ledger')::text AS exists",
  );
  if (!table.rows[0]?.exists) return;
  const state = await client.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.usage_ledger_org_recent_idx')`,
  );
  if (state.rows[0]?.valid) return;
  if (state.rows.length) {
    // Interrupted concurrent builds can leave an invalid index with this name.
    await client.query('DROP INDEX CONCURRENTLY IF EXISTS "usage_ledger_org_recent_idx"');
  }
  await client.query(
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_ledger_org_recent_idx" ON "usage_ledger" USING btree ("org_id", "created_at" DESC NULLS FIRST, "id" DESC NULLS FIRST)',
  );
}

/** 0092 adds brand_id to an existing, potentially large metering table. */
async function prepareUsageBrandIndex(client: pg.PoolClient): Promise<void> {
  const column = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.usage_ledger'::regclass
         AND attname = 'brand_id' AND NOT attisdropped
     ) AS exists`,
  );
  if (!column.rows[0]?.exists) return;
  const state = await client.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.usage_ledger_org_brand_created_idx')`,
  );
  if (state.rows[0]?.valid) return;
  if (state.rows.length) {
    await client.query('DROP INDEX CONCURRENTLY IF EXISTS "usage_ledger_org_brand_created_idx"');
  }
  await client.query(
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_ledger_org_brand_created_idx" ON "usage_ledger" USING btree ("org_id", "brand_id", "created_at")',
  );
}

/**
 * A populated run journal must keep accepting claims while its observational
 * template-cohort index is built. A fresh install gets the same index from 0098.
 */
async function prepareTemplateCohortIndex(client: pg.PoolClient): Promise<void> {
  const column = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = to_regclass('public.pipeline_runs')
         AND attname = 'template_snapshot' AND NOT attisdropped
     ) AS exists`,
  );
  if (!column.rows[0]?.exists) return;
  const state = await client.query<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.pipeline_runs_template_cohort_idx')`,
  );
  if (state.rows[0]?.valid) return;
  if (state.rows.length) {
    // PostgreSQL retains an invalid index after an interrupted concurrent build.
    await client.query('DROP INDEX CONCURRENTLY IF EXISTS "pipeline_runs_template_cohort_idx"');
  }
  await client.query(
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS "pipeline_runs_template_cohort_idx" ON "pipeline_runs" USING btree ("org_id", "brand_id", "created_at", "id") WHERE "template_snapshot" IS NOT NULL',
  );
}

/**
 * A migration transaction must never rewrite every row of a populated table.
 * Each page commits independently. Selecting pages by the stable primary key
 * also lets a failed post-migration step resume without changing assigned UUIDs.
 */
async function backfillPages(client: pg.PoolClient, sql: string, startedAt?: Date): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const params = startedAt ? [cursor, 500, startedAt] : [cursor, 500];
    const result: pg.QueryResult<{ cursor: string }> = await client.query(sql, params);
    if (!result.rows[0]) return;
    cursor = result.rows[0].cursor;
  }
}

async function backfillPaidReplyHistory(client: pg.PoolClient): Promise<void> {
  const state = await client.query<{ started_at: Date; completed_at: Date | null }>(
    "SELECT started_at, completed_at FROM paid_reply_backfill_state WHERE id = 1",
  );
  if (!state.rows[0]) throw new Error("Paid reply backfill state is missing");
  if (state.rows[0].completed_at) return;
  const startedAt = state.rows[0].started_at;

  // Explicit defaults do not infer paid consent from the existing free feature.
  await backfillPages(
    client,
    `
    WITH batch AS (
      SELECT id FROM organization WHERE ($1::text IS NULL OR id > $1::text)
      ORDER BY id LIMIT $2
    ), inserted AS (
      INSERT INTO organization_paid_reply_settings (org_id)
      SELECT id FROM batch ON CONFLICT DO NOTHING RETURNING org_id
    )
    SELECT id AS cursor FROM batch ORDER BY id DESC LIMIT 1`,
  );
  await backfillPages(
    client,
    `
    WITH batch AS (
      SELECT id, org_id FROM brands WHERE ($1::uuid IS NULL OR id > $1::uuid)
      ORDER BY id LIMIT $2
    ), inserted AS (
      INSERT INTO brand_paid_reply_settings (org_id, brand_id)
      SELECT org_id, id FROM batch ON CONFLICT DO NOTHING RETURNING brand_id
    )
    SELECT id AS cursor FROM batch ORDER BY id DESC LIMIT 1`,
  );

  // A failed refresh may retain rows, so version only persisted samples.
  await backfillPages(
    client,
    `
    WITH batch AS (
      SELECT id FROM news_items WHERE ($1::uuid IS NULL OR id > $1::uuid)
      ORDER BY id LIMIT $2
    ), updated AS (
      UPDATE news_items i SET comments_sample_version = gen_random_uuid()
      FROM batch b WHERE i.id = b.id AND i.comments_sample_version IS NULL
        AND EXISTS (SELECT 1 FROM news_comments c WHERE c.item_id = i.id)
      RETURNING i.id
    )
    SELECT id AS cursor FROM batch ORDER BY id DESC LIMIT 1`,
  );
  await backfillPages(
    client,
    `
    WITH batch AS (
      SELECT publication_id AS id FROM publication_comment_samples
      WHERE ($1::uuid IS NULL OR publication_id > $1::uuid)
      ORDER BY publication_id LIMIT $2
    ), updated AS (
      UPDATE publication_comment_samples s SET sample_version = gen_random_uuid()
      FROM batch b WHERE s.publication_id = b.id AND s.sample_version IS NULL
        AND EXISTS (SELECT 1 FROM publication_comments c WHERE c.publication_id = s.publication_id)
      RETURNING s.publication_id
    )
    SELECT id AS cursor FROM batch ORDER BY id DESC LIMIT 1`,
  );

  // Preserve a ready aggregate only when it still describes the current rows.
  await backfillPages(
    client,
    `
    WITH batch AS (
      SELECT item_id AS id FROM news_comment_analyses
      WHERE ($1::uuid IS NULL OR item_id > $1::uuid)
      ORDER BY item_id LIMIT $2
    ), updated AS (
      UPDATE news_comment_analyses a SET sample_version =
        CASE WHEN (a.sample_checked_at = i.comments_checked_at
                        OR i.comments_status IN ('error', 'unavailable'))
                       AND i.comments_sample_version IS NOT NULL
          THEN i.comments_sample_version ELSE gen_random_uuid() END
      FROM batch b JOIN news_items i ON i.id = b.id
      WHERE a.item_id = b.id AND a.sample_version IS NULL
      RETURNING a.item_id
    )
    SELECT id AS cursor FROM batch ORDER BY id DESC LIMIT 1`,
  );
  await backfillPages(
    client,
    `
    WITH batch AS (
      SELECT publication_id AS id FROM publication_comment_analyses
      WHERE ($1::uuid IS NULL OR publication_id > $1::uuid)
      ORDER BY publication_id LIMIT $2
    ), updated AS (
      UPDATE publication_comment_analyses a SET sample_version =
        CASE WHEN (a.sample_checked_at = s.checked_at
                        OR s.status IN ('error', 'unavailable'))
                       AND s.sample_version IS NOT NULL
          THEN s.sample_version ELSE gen_random_uuid() END
      FROM batch b JOIN publication_comment_samples s ON s.publication_id = b.id
      WHERE a.publication_id = b.id AND a.sample_version IS NULL
      RETURNING a.publication_id
    )
    SELECT id AS cursor FROM batch ORDER BY id DESC LIMIT 1`,
  );

  // Prior manual admissions consume their exact sample; no paid call is made.
  await backfillPages(
    client,
    `
    WITH batch AS (
      SELECT id, org_id, brand_id, comments_sample_version AS sample_version,
        comments_checked_at AS checked_at
      FROM news_items WHERE ($1::uuid IS NULL OR id > $1::uuid)
      ORDER BY id LIMIT $2
    ), inserted AS (
      INSERT INTO paid_reply_analysis_attempts
        (org_id, brand_id, target_kind, target_id, sample_version,
         admission_id, origin, status, completed_at)
      SELECT b.org_id, b.brand_id, 'source_comment', b.id, b.sample_version,
        a.id, 'legacy', 'legacy_consumed', now()
      FROM batch b JOIN LATERAL (
        SELECT id FROM analysis_admissions
        WHERE org_id = b.org_id AND target_kind = 'source_comment' AND target_id = b.id
          AND requested_at <= $3::timestamptz
        ORDER BY requested_at DESC, id DESC LIMIT 1
      ) a ON true WHERE b.sample_version IS NOT NULL
        AND (b.checked_at IS NULL OR b.checked_at <= $3::timestamptz)
      ON CONFLICT DO NOTHING RETURNING id
    )
    SELECT id AS cursor FROM batch ORDER BY id DESC LIMIT 1`,
    startedAt,
  );
  await backfillPages(
    client,
    `
    WITH batch AS (
      SELECT publication_id AS id, org_id, brand_id, sample_version,
        checked_at
      FROM publication_comment_samples
      WHERE ($1::uuid IS NULL OR publication_id > $1::uuid)
      ORDER BY publication_id LIMIT $2
    ), inserted AS (
      INSERT INTO paid_reply_analysis_attempts
        (org_id, brand_id, target_kind, target_id, sample_version,
         admission_id, origin, status, completed_at)
      SELECT b.org_id, b.brand_id, 'publication_comment', b.id, b.sample_version,
        a.id, 'legacy', 'legacy_consumed', now()
      FROM batch b JOIN LATERAL (
        SELECT id FROM analysis_admissions
        WHERE org_id = b.org_id AND target_kind = 'publication_comment' AND target_id = b.id
          AND requested_at <= $3::timestamptz
        ORDER BY requested_at DESC, id DESC LIMIT 1
      ) a ON true WHERE b.sample_version IS NOT NULL
        AND (b.checked_at IS NULL OR b.checked_at <= $3::timestamptz)
      ON CONFLICT DO NOTHING RETURNING id
    )
    SELECT id AS cursor FROM batch ORDER BY id DESC LIMIT 1`,
    startedAt,
  );
  await client.query(
    "UPDATE paid_reply_backfill_state SET completed_at = now() WHERE id = 1 AND completed_at IS NULL",
  );
}

async function validateBodyRevision(client: pg.PoolClient): Promise<void> {
  const result = await client.query<{ validated: boolean }>(
    `SELECT convalidated AS validated FROM pg_constraint
     WHERE conrelid = to_regclass('public.content_items')
       AND conname = 'content_items_body_revision_check'`,
  );
  if (result.rows[0] && !result.rows[0].validated) {
    await client.query(
      'ALTER TABLE "content_items" VALIDATE CONSTRAINT "content_items_body_revision_check"',
    );
  }
}

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
      // A blocking advisory-lock query remains in a virtual transaction while
      // waiting. CREATE INDEX CONCURRENTLY in the lock holder then waits for
      // that transaction, producing a deadlock. Poll with completed statements
      // so waiting migrators never keep a transaction open.
      for (;;) {
        const lock = await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS acquired",
          [MIGRATION_LOCK_ID],
        );
        if (lock.rows[0]?.acquired) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      try {
        await prepareUsageHistoryIndex(client);
        await prepareTemplateCohortIndex(client);
        await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
        await prepareUsageBrandIndex(client);
        await prepareTemplateCohortIndex(client);
        await backfillPaidReplyHistory(client);
        await validateBodyRevision(client);
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
