import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AdaptationStatus, nextItemStatus } from "@pubrick/shared";
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

/** The migration that stages a refine proposal on the server, proved below. */
const REFINE_PROPOSALS_MIGRATION = "0016_refine_proposals";

/**
 * The migration that gives a half-delivered post a status of its own — and the
 * only one in this folder that rewrites existing rows on purpose.
 */
const PARTIAL_MIGRATION = "0018_partially_published";

/**
 * The index the queue's order is read through, proved additive AND non-vacuous
 * below.
 *
 * Tagged 0020 rather than 0017, which was the next free number when it was
 * first generated: two designs ahead of this one had claimed 0017/0018 and 0019
 * on branches that had not landed then, and a tag collision is a merge conflict
 * in the one file where the resolution is not obvious. They have landed since,
 * and this branch was rebased onto them and the migration regenerated against
 * main's 0019 — so the gap the dodge left (0017 was never this file's number)
 * is now no gap at all. The journal does still skip 0010, so a gap would not be
 * a novelty either way.
 */
const QUEUE_ORDER_MIGRATION = "0020_queue_page_order";

/**
 * Every timestamp column in the database that carries a zone, in the order
 * `information_schema` sorts them. Written out rather than derived from the
 * schema: the point of the assertion is that the DATABASE matches a decision
 * somebody wrote down, and a list computed from the same types the migration
 * was generated from could only ever agree with itself.
 *
 * Twelve of them are the publishing path, converted by 0014. Proposals,
 * publication assertions, public feeds, monitored news, guidance revisions,
 * calendar slots, and manual and scheduled Autopilot decisions were born zoned in later migrations. They are deliberately
 * absent from `UNZONED_TABLES`, whose columns remain naive.
 */
const ZONED_COLUMNS = [
  "adaptation_proposals.created_at",
  "adaptations.created_at",
  "adaptations.scheduled_at",
  "adaptations.updated_at",
  "analysis_admissions.completed_at",
  "analysis_admissions.lease_until",
  "analysis_admissions.requested_at",
  "analysis_admissions.sample_checked_at",
  "autopilot_configs.last_manual_plan_at",
  "autopilot_configs.updated_at",
  "autopilot_dispatches.created_at",
  "autopilot_manual_attempts.completed_at",
  "autopilot_manual_attempts.created_at",
  "autopilot_manual_attempts.started_at",
  "autopilot_scan_events.finished_at",
  "autopilot_scan_events.started_at",
  "brand_feeds.created_at",
  "brands.created_at",
  "brands.updated_at",
  "calendar_slots.created_at",
  "calendar_slots.retry_after",
  "calendar_slots.scheduled_at",
  "calendar_slots.topic_updated_at",
  "calendar_slots.updated_at",
  "channels.created_at",
  "channels.updated_at",
  "claim_reviews.completed_at",
  "claim_reviews.created_at",
  "claim_reviews.lease_expires_at",
  "claim_reviews.started_at",
  "client_review_links.created_at",
  "client_review_links.expires_at",
  "client_review_links.reviewed_at",
  "client_review_links.revoked_at",
  "content_items.created_at",
  "content_items.first_opened_at",
  "content_items.updated_at",
  "content_versions.created_at",
  "draft_revision_proposals.created_at",
  "editorial_notes.created_at",
  "feed_entries.published_at",
  "knowledge_auto_index.last_attempt_at",
  "knowledge_auto_index.updated_at",
  "knowledge_entries.created_at",
  "knowledge_entries.updated_at",
  "media_assets.created_at",
  "memorable_dates.created_at",
  "memorable_dates.updated_at",
  "news_comment_analyses.created_at",
  "news_comment_analyses.sample_checked_at",
  "news_comment_collection_configs.last_scanned_at",
  "news_comment_collection_configs.updated_at",
  "news_comments.created_at",
  "news_comments.published_at",
  "news_items.comments_checked_at",
  "news_items.created_at",
  "news_items.published_at",
  "news_items.relevance_scored_at",
  "news_relevance_batch_items.completed_at",
  "news_relevance_batches.completed_at",
  "news_relevance_batches.created_at",
  "news_relevance_batches.started_at",
  "news_sources.created_at",
  "news_sources.last_checked_at",
  "news_sources.updated_at",
  "notification_digest_configs.updated_at",
  "notification_digest_snapshots.created_at",
  "notification_events.created_at",
  "notification_events.updated_at",
  "notification_settings.updated_at",
  "organization_api_keys.created_at",
  "organization_api_keys.revoked_at",
  "prompt_decision_revisions.decided_at",
  "prompt_decisions.created_at",
  "prompt_revisions.created_at",
  "publication_comment_analyses.created_at",
  "publication_comment_analyses.sample_checked_at",
  "publication_comment_collection_configs.last_scanned_at",
  "publication_comment_collection_configs.updated_at",
  "publication_comment_samples.checked_at",
  "publication_comment_samples.requested_at",
  "publication_comments.published_at",
  "publication_metrics.checked_at",
  "publications.asserted_at",
  "publications.created_at",
  "refine_proposals.created_at",
  "search_credentials.updated_at",
  "search_requests.completed_at",
  "search_requests.created_at",
  "telegram_login_attempts.created_at",
  "telegram_login_attempts.expires_at",
  "telegram_login_attempts.last_begin_at",
  "telegram_login_attempts.next_attempt_at",
  "telegram_login_attempts.updated_at",
  "telegram_source_accounts.connected_at",
  "telegram_source_accounts.last_private_resolve_at",
  "topic_suggestion_requests.created_at",
  "topic_suggestion_requests.updated_at",
  "topics.blocked_at",
  "topics.created_at",
  "topics.updated_at",
  "webhook_deliveries.created_at",
  "webhook_deliveries.next_attempt_at",
  "webhook_deliveries.updated_at",
  "webhook_subscriptions.created_at",
  "webhook_subscriptions.revoked_at",
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

/** The migration that gives a failed delivery a coded reason, proved additive below. */
const FAILURE_REASON_MIGRATION = "0019_missed_slot_has_a_name";

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
  // 0019's, nullable for the same reason and refusing a misspelling for a
  // sharper one: every reader of this column is a `Record<PublishFailureReason,
  // …>` or a comparison against one member, so a value outside the set reads as
  // "no reason recorded" — i.e. as a row that failed before the column existed.
  { table: "adaptations", column: "failure_reason", bogus: "schedule_mised" },
];

/**
 * Every `%_check`-named constraint the `PINNED_COLUMNS` loop above cannot
 * drive, with the reason for each and a pointer to where it IS proved.
 *
 * The "adds the invariants to a database that already holds rows of every
 * table" test below counts every `_check` constraint as a proxy for "did the
 * enum constraints reach the database", and that proxy stops being exact the
 * moment a check exists the loop does not cover — this is where such a check
 * declares itself, so the count stays a count of something rather than a
 * number two lists happen to have summed to once.
 */
const NON_ENUM_CHECKS = [
  // Webhook payload and subscription shape are checked on late-created tables.
  "webhook_deliveries_event_check",
  "webhook_deliveries_status_check",
  "webhook_deliveries_attempts_check",
  "webhook_subscriptions_name_check",
  "webhook_subscriptions_endpoint_check",
  // API key name and scope are pinned at the database boundary too.
  "organization_api_keys_scope_check",
  "organization_api_keys_name_check",
  // Video media carries a distinct shape and content items may attach one medium.
  "media_assets_kind_check",
  "media_assets_shape_check",
  "media_assets_byte_size_check",
  "content_items_one_media_check",
  // 0064 stores article image positions and accessibility text outside the
  // plain-text body. API and public-feed tests exercise valid slot writes.
  "content_image_slots_paragraph_check",
  "content_image_slots_alt_check",
  "content_image_slots_caption_check",
  // 0085 pins both saved image alignment and its immutable public snapshot.
  "content_image_slots_alignment_check",
  "feed_entry_images_paragraph_check",
  "feed_entry_images_position_check",
  "feed_entry_images_alt_check",
  "feed_entry_images_caption_check",
  "feed_entry_images_alignment_check",
  // 0059: archive is a reversible state; its previous status must be present
  // exactly while archived. The dedicated test below proves both directions.
  "content_items_archived_from_status_check",
  "content_items_archive_pair_check",
  // Guest approval capabilities are new after the historical seed. Their
  // format and verdict relationship are exercised by client-review e2e tests.
  "client_review_links_token_hash_check",
  "client_review_links_snapshot_hash_check",
  "client_review_links_verdict_check",
  "client_review_links_comment_length_check",
  "client_review_links_review_pair_check",
  // Vector provenance must accompany every stored embedding. The knowledge
  // E2E suite covers clearing and writing the metadata with the vector.
  "knowledge_entries_embedding_metadata_check",
  // News feedback similarities use the same 768-dimension model provenance gate.
  "news_items_embedding_metadata_check",
  // Notification tables arrive after the historical seed; worker outbox tests
  // exercise their values, and schema-invariants checks the enum expressions.
  "notification_events_event_check",
  "notification_digest_configs_hour_check",
  "notification_events_status_check",
  // Added with the comment sample after the historical seed; worker persistence e2e
  // proves the database rejects an off-list status on a populated story.
  "news_items_comments_status_check",
  "news_comment_collection_configs_revision_check",
  // Added after the pre-0009 seed; pinned by schema-invariants and source e2e tests.
  "news_sources_kind_check",
  // A private source always carries an encrypted channel peer, while public
  // sources cannot carry one. Exercised by private source persistence e2e.
  "news_sources_private_peer_check",
  // A login attempt stores encrypted phone/session material and bounded retries;
  // the source login API owns allowed transitions and exhaustion.
  "telegram_login_attempts_stage_check",
  "telegram_login_attempts_attempts_check",
  // 0061: scheduling limits and channel admission remain enforced for direct SQL writers.
  "topics_priority_check",
  "autopilot_configs_planning_daily_limit_check",
  "autopilot_configs_auto_plan_channels_check",
  // 0022's: only the manual VC.ru channel may omit encrypted credentials.
  // The API e2e suite proves both accepted and refused channel shapes.
  "channels_credentials_mode_check",
  // Automatic reads must remain a per-VK opt-in even for direct SQL writers.
  "channels_metrics_auto_refresh_vk_check",
  // 0015's: non-null exactly when `scope = 'fragment'`. Not an enum pin at all
  // — it pins a value into a RELATIONSHIP with another column, so there is no
  // single `bogus` scalar the loop could try. Proved directly by "adds the
  // fragment unit delta..." (both wrong shapes refused, both right ones
  // accepted).
  "content_versions_unit_delta_scope_check",
  // 0016's two. `verb` IS an enum pin and would belong in `PINNED_COLUMNS`,
  // except that the loop works by UPDATEing a row `seedEveryTable` wrote — and
  // that seed runs at the PRE-0009 schema, where `refine_proposals` does not
  // exist yet. An UPDATE over an empty table refuses nothing and would report
  // the constraint as ACCEPTING the bogus value, which is the one answer worse
  // than not checking. Both are proved directly instead, by "creates the refine
  // proposal table..." — an off-list verb and an empty range each refused with
  // 23514, against the real database.
  "refine_proposals_verb_check",
  "refine_proposals_range_check",
  // The guidance table does not exist when the pre-0009 seed is written, so the
  // generic UPDATE loop cannot exercise its role pin. The schema invariant
  // test checks the enum expression; the repository e2e checks version writes.
  "prompt_revisions_role_check",
  "prompt_revisions_version_positive_check",
  "prompt_revisions_guidance_limit_check",
  // The nullable calendar error enum is on a table that did not exist when
  // seedEveryTable wrote its pre-0009 rows, so the UPDATE loop cannot test it.
  // schema-invariants.test.ts verifies the schema declaration; this count
  // verifies that the generated migration installed the database guard.
  "calendar_slots_error_code_check",
  "calendar_slots_content_type_check",
  "calendar_slots_seo_keywords_check",
  "calendar_slots_topic_snapshot_check",
  // Memorable dates were born after the historical seed; the API e2e proves
  // invalid MM-DD values are refused and this count pins the SQL guard.
  "memorable_dates_month_day_check",
  // Knowledge categories allow custom names but retain length, trim and control
  // character checks. The knowledge e2e inserts a real note and proves the
  // constraint rejects invalid data at head.
  "knowledge_entries_category_check",
  // These late enum pins: neither topics nor news items exists in the pre-0009
  // seed. The topic API e2e writes real rows and proves both reject off-list
  // values with SQLSTATE 23514.
  "topics_status_check",
  "topics_content_type_check",
  "topics_seo_keywords_check",
  "topics_block_state_check",
  // 0033's late enum pins are exercised by the topic API and suggestion worker
  // e2e suites; this pre-0009 seed has no topic or request rows to update.
  "topics_origin_check",
  "topic_suggestion_requests_status_check",
  "topic_suggestion_requests_error_code_check",
  // 0057 adds an origin pin; historical request rows receive the manual default.
  "topic_suggestion_requests_origin_check",
  "news_items_editor_signal_check",
  "news_items_relevance_status_check",
  "news_items_relevance_urgency_check",
  "news_items_relevance_error_code_check",
  "news_items_relevance_score_check",
  // 0050 keeps the editor adjustment bounded independently of the model score.
  // The worker repository e2e covers a nonzero write and the raw/rank split.
  "news_items_relevance_feedback_delta_check",
  "news_items_relevance_consistency_check",
  "news_items_relevance_attempts_check",
  // 0080's paid recheck journal is created after the historical seed.
  "news_relevance_batches_days_check",
  "news_relevance_batches_counts_check",
  "news_relevance_batches_unrecorded_check",
  "news_relevance_batches_status_check",
  "news_relevance_batches_error_code_check",
  "news_relevance_batch_items_status_check",
  "news_relevance_batch_items_error_code_check",
  // The metric table is created after the pre-0009 seed. Analytics e2e proves
  // measured zero and missing values; these checks pin the stored shape.
  "publication_metrics_status_check",
  "publication_metrics_counts_check",
  // 0065: bounded Telegram publication discussion samples, distinct from news.
  "publication_comment_samples_status_check",
  "publication_comment_samples_error_check",
  "publication_comments_message_id_check",
  "publication_comments_body_check",
  // 0066–0067: paid analysis admission and bounded publication result.
  "analysis_admissions_target_kind_check",
  "analysis_admissions_unrecorded_calls_check",
  "publication_comment_analyses_sample_size_check",
  // 0071–0072: search and advisory review records arrive after the historical seed.
  "search_requests_status_check",
  "search_requests_result_check",
  "claim_reviews_status_check",
  "claim_reviews_body_hash_check",
  "claim_reviews_error_code_check",
  "claim_reviews_unrecorded_calls_check",
  // 0074's operator attempts are created after the historical seed. API and
  // worker e2e cover active/terminal transitions and an off-list decision.
  "autopilot_manual_attempts_status_check",
  "autopilot_manual_attempts_decision_check",
  "autopilot_manual_attempts_terminal_check",
  // 0078's scheduled admission events have a closed status/decision pair.
  "autopilot_scan_events_status_check",
  "autopilot_scan_events_decision_check",
  "autopilot_scan_events_terminal_check",
  // 0079's immutable review events link only verified pinned revisions.
  "prompt_decisions_verdict_check",
  "prompt_decisions_ordinal_positive_check",
  "prompt_decision_revisions_role_check",
  "prompt_decision_revisions_version_positive_check",
  // 0076 adds explicit opt-in for publication reply sampling.
  "publication_comment_collection_configs_revision_check",
  // 0084: the accepted Telegram cover and pending reply must remain a coherent receipt.
  // The nullable enum pin is exercised against real rows by the worker repository spec.
  "publications_partial_followup_outcome_check",
  "publications_partial_telegram_check",
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
 * after them. New columns are null on pre-existing rows unless an explicit,
 * safe default is part of their contract (VK background reads are opt-in).
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
        added.filter((key) => {
          if (table === "channels" && key === "metrics_auto_refresh") {
            return afterRow[key] !== false;
          }
          // 0060 intentionally makes historical items ineligible for deletion:
          // an orphaned receipt may already have lost its item link.
          if (table === "content_items" && key === "is_safe_to_delete") {
            return afterRow[key] !== false;
          }
          // 0077 keeps existing channel text byte-for-byte while giving old
          // adaptations and their versions an explicitly empty tag list.
          if ((table === "adaptations" || table === "content_versions") && key === "hashtags") {
            return JSON.stringify(afterRow[key]) !== "[]";
          }
          return afterRow[key] !== null;
        }),
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

/**
 * Every multiset of `size` over `values` — combinations WITH repetition, in a
 * fixed order.
 *
 * A fan-out is a bag of delivery statuses, not a sequence: `[published,
 * failed]` and `[failed, published]` are the same item seen twice, and the
 * fold has no order to be sensitive to. Enumerating multisets rather than
 * tuples is what keeps the ratchet below a table somebody can read (37 rows)
 * instead of 258.
 */
function multisets<T>(values: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  const out: T[][] = [];
  values.forEach((value, index) => {
    for (const rest of multisets(values.slice(index), size - 1)) out.push([value, ...rest]);
  });
  return out;
}

/**
 * THE FAN-OUTS THE RATCHET BELOW RUNS OVER.
 *
 * Every multiset over the six statuses available at migration 0018 up to TWO
 * deliveries (6 + 21). The later `manual_ready` status cannot be seeded before
 * 0018, so this historical migration ratchet deliberately pins that vocabulary.
 * — the size at which the fold's every clause can already disagree with the
 * SQL's — plus every multiset of size three over the three statuses that decide
 * anything (10), which is where a predicate written with `bool_and`/`bool_or`
 * or with a clause in the wrong direction first answers differently from one
 * written with `exists`. And the empty fan-out, which is the trap itself: an
 * item whose channels have all been deleted, where `every` is vacuously true
 * for all three arms and `bool_and` is `NULL`.
 */
const PRE_MANUAL_STATUSES = [
  "pending",
  "scheduled",
  "queued",
  "publishing",
  "published",
  "failed",
] as const satisfies readonly AdaptationStatus[];
const FAN_OUTS: AdaptationStatus[][] = [
  ...multisets(PRE_MANUAL_STATUSES, 0),
  ...multisets(PRE_MANUAL_STATUSES, 1),
  ...multisets(PRE_MANUAL_STATUSES, 2),
  ...multisets(["published", "failed", "queued"] as const, 3),
];

/**
 * One org, one brand, and one item per fan-out — each adaptation on a channel
 * of its own.
 *
 * DELIBERATELY NOT `seedEveryTable`, and that is the whole reason this helper
 * exists. That seed feeds `expectNoRowRewritten`, which asserts that no
 * pre-existing `content_items` value is rewritten between 0009 and head and
 * calls a backfill "precisely the class this test exists to catch"; it stays
 * green only because the one item it writes is a `draft` with a `pending`
 * adaptation, which this migration's predicate cannot match. Putting a
 * stranded fan-out in there would make the backfill fail the test that guards
 * every OTHER migration against rewriting rows.
 *
 * A channel per position, not one channel for all of them:
 * `adaptations_one_live_per_item_channel` admits at most one non-`published`
 * row per (item, channel), so `["queued", "queued"]` on one channel is a
 * `23505` about the seed rather than anything the migration did.
 */
async function seedFanOuts(
  pool: pg.Pool,
  org: string,
  fanOuts: readonly (readonly AdaptationStatus[])[],
  itemStatus = "approved",
): Promise<string[]> {
  await pool.query("INSERT INTO organization (id, name, slug) VALUES ($1, $1, $1)", [org]);
  const brand = await pool.query(
    "INSERT INTO brands (org_id, name) VALUES ($1, 'Brand') RETURNING id",
    [org],
  );
  const brandId = brand.rows[0].id as string;
  const channelIds: string[] = [];
  for (let position = 0; position < Math.max(0, ...fanOuts.map((f) => f.length)); position++) {
    const channel = await pool.query(
      "INSERT INTO channels (org_id, brand_id, platform, name, credentials_encrypted) VALUES ($1, $2, 'telegram', $3, 'blob') RETURNING id",
      [org, brandId, `Channel ${position}`],
    );
    channelIds.push(channel.rows[0].id as string);
  }
  const itemIds: string[] = [];
  for (const fanOut of fanOuts) {
    const item = await pool.query(
      "INSERT INTO content_items (org_id, brand_id, body, status, origin) VALUES ($1, $2, 'Ship it.', $3, 'ai') RETURNING id",
      [org, brandId, itemStatus],
    );
    const itemId = item.rows[0].id as string;
    itemIds.push(itemId);
    for (const [position, status] of fanOut.entries()) {
      await pool.query(
        "INSERT INTO adaptations (org_id, content_item_id, channel_id, status, origin) VALUES ($1, $2, $3, $4, 'ai')",
        [org, itemId, channelIds[position], status],
      );
    }
  }
  return itemIds;
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
   * 0020 adds the index the queue's `ORDER BY created_at DESC, id DESC` is read
   * through, and nothing else — so, exactly as with 0007 above, an end-state
   * assertion alone would be unable to tell it from an empty file. Its ABSENCE
   * at the migration before is asserted first, and the rows it indexes are real
   * and compared field for field afterwards: `CREATE INDEX` takes a lock and
   * rewrites nothing, and this is the assertion that says so.
   *
   * The DESCENDING declaration is part of what is pinned. A plain
   * `(org_id, created_at, id)` btree can serve this sort backwards, so the two
   * are not distinguishable by a query plan — they ARE distinguishable by what
   * the schema says the queue's order is, and the keyset page that reads it
   * next seeks in exactly this direction.
   *
   * The NULLS placement is pinned too, and that one IS visible to the planner:
   * `DESC` in a query means `DESC NULLS FIRST`, so an index declared
   * `DESC NULLS LAST` — which is what drizzle's bare `.desc()` emits, and what
   * this migration said when it was first written — cannot serve the queue's
   * `ORDER BY` at all. Postgres prints the default placement as nothing, so the
   * assertion is that `NULLS LAST` is ABSENT rather than that `NULLS FIRST` is
   * present. The plan it buys is asserted where a plan can be read, in
   * `apps/api/src/content/content-list-cost.e2e.spec.ts`.
   */
  it("adds the queue's order index without touching the rows it indexes", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(QUEUE_ORDER_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seeded: pg.QueryResultRow[];
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        const pre = await pool.query(
          "SELECT indexname FROM pg_indexes WHERE tablename = 'content_items'",
        );
        // If an earlier migration already created it, "0020 added it" would be
        // a lie and the assertion below would pass over an empty file.
        expect(pre.rows.map((r) => r.indexname)).not.toContain(
          "content_items_org_id_created_at_id_idx",
        );

        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('org_order', 'Ordered', 'ordered')",
        );
        const brand = await pool.query(
          "INSERT INTO brands (org_id, name) VALUES ('org_order', 'Brand') RETURNING id",
        );
        // Two drafts sharing a `created_at` to the microsecond — the shape the
        // generate worker's single-transaction write produces, and the whole
        // reason the index carries `id` as well.
        const items = await pool.query(
          `INSERT INTO content_items (org_id, brand_id, title, body, created_at)
             VALUES ('org_order', $1, 'One', 'the first body', '2026-09-09 08:00:00+00'),
                    ('org_order', $1, 'Two', 'the second body', '2026-09-10 08:00:00+00'),
                    ('org_order', $1, 'Three', 'the third body', '2026-09-10 08:00:00+00')
           RETURNING id, title, body, status, origin, created_at`,
          [brand.rows[0].id],
        );
        seeded = [...items.rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      const rows = await after.query(
        "SELECT id, title, body, status, origin, created_at FROM content_items ORDER BY id",
      );
      const idx = await after.query(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'content_items'",
      );
      await after.end();

      expect(rows.rows).toEqual(seeded);
      const byName = new Map(idx.rows.map((r) => [r.indexname as string, r.indexdef as string]));
      // Presence first, then shape: an empty 0020 leaves `get` undefined, and
      // `toContain` on undefined reports an argument-type complaint rather than
      // the missing index.
      expect([...byName.keys()]).toContain("content_items_org_id_created_at_id_idx");
      const definition = byName.get("content_items_org_id_created_at_id_idx");
      expect(definition).toContain("org_id");
      expect(definition).toContain("created_at DESC");
      expect(definition).toContain("id DESC");
      expect(definition).not.toContain("NULLS LAST");
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
        expect(await refusal(pool, "UPDATE channels SET credentials_encrypted = NULL")).toBe(
          CHECK_VIOLATION,
        );
        expect(await refusal(pool, "UPDATE channels SET platform = 'vc_ru'")).toBe(CHECK_VIOLATION);
        await pool.query("UPDATE channels SET platform = 'vc_ru', credentials_encrypted = NULL");
      } finally {
        await pool.end();
      }
    } finally {
      await fresh.drop();
    }
  });

  it("preserves old items and enforces reversible archive state", async () => {
    const fresh = await withFreshDatabase(url as string);
    try {
      await runMigrations(fresh.url);
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const { itemId } = await seedEveryTable(pool, "org_archive");
        const read = async () =>
          (
            await pool.query(
              "SELECT status, archived_from_status FROM content_items WHERE id = $1",
              [itemId],
            )
          ).rows[0];

        expect(await read()).toEqual({ status: "draft", archived_from_status: null });
        expect(
          await refusal(pool, "UPDATE content_items SET status = 'archived' WHERE id = $1", [
            itemId,
          ]),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            pool,
            "UPDATE content_items SET archived_from_status = 'draft' WHERE id = $1",
            [itemId],
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            pool,
            "UPDATE content_items SET status = 'archived', archived_from_status = 'archived' WHERE id = $1",
            [itemId],
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            pool,
            "UPDATE content_items SET status = 'archived', archived_from_status = 'draft_typo' WHERE id = $1",
            [itemId],
          ),
        ).toBe(CHECK_VIOLATION);

        await pool.query(
          "UPDATE content_items SET status = 'archived', archived_from_status = 'draft' WHERE id = $1",
          [itemId],
        );
        expect(await read()).toEqual({ status: "archived", archived_from_status: "draft" });
        expect(
          await refusal(pool, "UPDATE content_items SET status = 'draft' WHERE id = $1", [itemId]),
        ).toBe(CHECK_VIOLATION);
        await pool.query(
          "UPDATE content_items SET status = archived_from_status, archived_from_status = NULL WHERE id = $1",
          [itemId],
        );
        expect(await read()).toEqual({ status: "draft", archived_from_status: null });
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
      expect(rows.content_items?.[0]?.is_safe_to_delete).toBe(false);
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

      expect(rows.rows).toEqual(
        seeded.map((row) => ({ ...row, outcome: null, analysis_admission_id: null })),
      );
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
   * 0019 lands a nullable column and a CHECK on `adaptations` — the busiest
   * table a running deployment has, and the one whose rows a self-hoster's
   * screens are looking at while the migration runs.
   *
   * ROWS THAT FAILED BEFORE IT KEEP THE MEANING THEY HAD. They come back with
   * `failure_reason` NULL, which is what the screens already render from
   * `last_error`. Back-filling a guess — `platform_rejected` is the tempting
   * one — would put a claim about a platform onto rows that may never have
   * reached one, and nothing can retroactively learn which class a delivery in
   * somebody else's database belonged to.
   *
   * AND THE CHECK HOLDS IN BOTH DIRECTIONS. A misspelling is refused; the real
   * value is stored. A test that only planted the bogus row would also pass if
   * the CHECK were `false`, or if the column had never arrived at all.
   */
  it("gives a failed delivery its coded reason without touching a row", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(FAILURE_REASON_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seeded: pg.QueryResultRow[];
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        // If the column were already here, "written before the migration" would
        // be a lie and everything below would prove nothing.
        const pre = await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'adaptations' AND column_name = 'failure_reason'",
        );
        expect(pre.rows).toHaveLength(0);

        await seedEveryTable(pool, "org_failure_reason");
        // The row this column exists to disambiguate: a delivery that failed
        // before anybody could say WHY in anything but prose.
        await pool.query(
          `UPDATE adaptations SET status = 'failed', last_error = 'Telegram 400: chat not found'
             WHERE org_id = 'org_failure_reason'`,
        );
        seeded = (await pool.query("SELECT * FROM adaptations ORDER BY id")).rows;
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      const rows = await after.query("SELECT * FROM adaptations ORDER BY id");
      const column = await after.query(
        "SELECT is_nullable, data_type, column_default FROM information_schema.columns WHERE table_name = 'adaptations' AND column_name = 'failure_reason'",
      );
      const refusedBogus = await refusal(
        after,
        "UPDATE adaptations SET failure_reason = 'schedule_mised' WHERE org_id = 'org_failure_reason'",
      );
      const acceptedReal = await refusal(
        after,
        "UPDATE adaptations SET failure_reason = 'schedule_missed' WHERE org_id = 'org_failure_reason'",
      );
      await after.end();

      expect(rows.rows).toEqual(
        seeded.map((row) => ({ ...row, failure_reason: null, hashtags: [], cta: null })),
      );
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
   * 0016 adds a table rather than a column, so "additive" is trivially true
   * and the claims worth proving are the two CONSTRAINTS — the ones that make
   * "one staged proposal per draft" and "a range a real selection could have
   * produced" facts about the database rather than about the one repository
   * that writes it today.
   *
   * And one constraint that is deliberately ABSENT, proved by writing the row
   * it would have refused: the anchor's length is measured in UTF-16 code
   * units by everything that produced it and in code points by Postgres
   * `length()`, so tying the range to it in SQL would refuse every selection
   * containing an emoji.
   */
  it("creates the refine proposal table with one row per draft, and no length arithmetic", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(REFINE_PROPOSALS_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seed: Awaited<ReturnType<typeof seedEveryTable>>;
      let otherItemId: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        // If the table were already here, everything below would be proving
        // something about a schema this migration did not create.
        const pre = await pool.query("SELECT to_regclass('public.refine_proposals') AS present");
        expect(pre.rows[0].present).toBeNull();
        seed = await seedEveryTable(pool, "org_refine_proposals");
        const other = await pool.query(
          "INSERT INTO content_items (org_id, brand_id, body) VALUES ('org_refine_proposals', $1, 'Another draft.') RETURNING id",
          [seed.brandId],
        );
        otherItemId = other.rows[0].id as string;
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const insert =
          "INSERT INTO refine_proposals (org_id, content_item_id, verb, selected_text, start_offset, end_offset, proposal, reason) VALUES ($1, $2, $3, $4, $5, $6, 'Passez nous voir.', 'Shorter, same meaning.')";
        const first = await refusal(after, insert, [
          "org_refine_proposals",
          seed.itemId,
          "shorten",
          "Ship it.",
          0,
          8,
        ]);
        expect(first, "the first proposal for a draft").toBeNull();

        // ONE PER DRAFT. The supersede — delete, then insert — is what the
        // screen's single proposal card rests on; without this a second press
        // arriving concurrently would leave a proposal nobody can see.
        const second = await refusal(after, insert, [
          "org_refine_proposals",
          seed.itemId,
          "warmer",
          "Ship it.",
          0,
          8,
        ]);
        expect(second).toBe(UNIQUE_VIOLATION);

        // A DIFFERENT draft is the ordinary case and must stay ordinary: the
        // index is one per item, not one per org.
        const otherDraft = await refusal(after, insert, [
          "org_refine_proposals",
          otherItemId,
          "punchier",
          "Another draft.",
          0,
          14,
        ]);
        expect(otherDraft).toBeNull();

        const offListVerb = await refusal(after, insert, [
          "org_refine_proposals",
          otherItemId,
          "translate",
          "Another draft.",
          0,
          14,
        ]);
        expect(offListVerb, "a verb outside REFINE_VERBS").toBe(CHECK_VIOLATION);

        // A collapsed caret replaces nothing; a negative start is not a
        // position in a string. Both are refusals the request schema also
        // makes, and this is the half a hand-written INSERT cannot skip.
        const collapsed = await refusal(after, insert, [
          "org_refine_proposals",
          otherItemId,
          "shorten",
          "",
          3,
          3,
        ]);
        const negative = await refusal(after, insert, [
          "org_refine_proposals",
          otherItemId,
          "shorten",
          "x",
          -1,
          4,
        ]);
        expect(collapsed).toBe(CHECK_VIOLATION);
        expect(negative).toBe(CHECK_VIOLATION);

        // THE CONSTRAINT THAT IS NOT THERE. "🥐" is one code point and TWO
        // UTF-16 code units, so this row's range is 4 while Postgres reads
        // `length(selected_text)` as 3. A constraint tying the two would
        // refuse it — and refuse a croissant emoji in a bakery's post.
        await after.query("DELETE FROM refine_proposals WHERE content_item_id = $1", [otherItemId]);
        const astral = await refusal(after, insert, [
          "org_refine_proposals",
          otherItemId,
          "warmer",
          "Un 🥐",
          0,
          5,
        ]);
        expect(astral, "a selection containing an emoji").toBeNull();
        const stored = await after.query(
          "SELECT selected_text, end_offset - start_offset AS span, length(selected_text) AS points FROM refine_proposals WHERE content_item_id = $1",
          [otherItemId],
        );
        expect(stored.rows[0]).toMatchObject({ selected_text: "Un 🥐", span: 5, points: 4 });

        // A proposal about a deleted draft is about nothing.
        await after.query("DELETE FROM content_items WHERE id = $1", [otherItemId]);
        const left = await after.query(
          "SELECT count(*)::int AS n FROM refine_proposals WHERE content_item_id = $1",
          [otherItemId],
        );
        expect(left.rows[0].n).toBe(0);
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
   * THE JOURNAL'S `when` INCREASES WITH ITS ORDER — the ratchet against a
   * migration that lands and is never applied.
   *
   * drizzle applies an entry only when
   * `Number(lastDbMigration.created_at) < migration.folderMillis`
   * (`drizzle-orm/pg-core/dialect.js`), where `lastDbMigration` is the row with
   * the LARGEST `created_at` already in `drizzle.__drizzle_migrations`. `when`
   * is the only thing it compares: not `idx`, not the tag. So an entry appended
   * to the journal with a `when` SMALLER than one already applied is skipped —
   * silently, with exit code 0, no warning, and for ever, because the maximum
   * only grows. The repair is a hand-run of the skipped SQL plus a manual
   * insert into that table.
   *
   * That is not hypothetical here: 0020 was generated as 0017 and renumbered by
   * hand to dodge a tag collision with two designs on unlanded branches. The
   * TAG moved forward; the `when` did not — and a branch carrying the real 0017
   * has a `when` 55 minutes older. Landing it after 0020 would create its
   * tables on no database that already had 0020, and nothing would say so
   * (reproduced end to end by the review of this branch).
   *
   * Hence the rule this test is the enforcement of: **a migration may land only
   * if its `when` is strictly greater than every `when` already in the journal;
   * tag order is cosmetic and must be kept in agreement with `when` order,
   * never relied on instead of it.** On a rebase that carries a migration, both
   * are refreshed — the tag to the next free number, the `when` to the moment
   * of landing.
   *
   * Gaps in the tag numbers are fine (0010 was never written); what is not fine
   * is two entries whose tag order and `when` order disagree.
   */
  it("keeps the journal's `when` strictly increasing, in tag order", async () => {
    const journal = JSON.parse(
      await fs.readFile(
        path.join(
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations"),
          "meta",
          "_journal.json",
        ),
        "utf8",
      ),
    ) as { entries: { idx: number; when: number; tag: string }[] };

    const whens = journal.entries.map((entry) => entry.when);
    const tags = journal.entries.map((entry) => entry.tag);
    expect(whens, "the journal's `when` values are not in ascending order").toEqual(
      [...whens].sort((a, b) => a - b),
    );
    // Two entries stamped the same millisecond make "strictly greater" false
    // for the second of them, which is the same skip by another route.
    expect(new Set(whens).size, "two entries share a `when`").toBe(whens.length);
    // Tag order is what a human reads the folder in. It carries no weight with
    // the migrator, so the only way it stays trustworthy is by agreeing.
    expect(tags, "tag order and journal order disagree").toEqual([...tags].sort());
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
  /**
   * THE BACKFILL, which is the one row rewrite this folder performs on purpose.
   *
   * Every item stranded at `approved` by a fan-out that ended in disagreement
   * is an item nothing can move: the only writer of that promotion is a
   * delivery, and every delivery this item had is already over. So the status
   * has to reach the rows that are ALREADY broken, or it would only ever
   * describe posts sent after the deploy.
   *
   * Its own seed, never `seedEveryTable` — see `seedFanOuts`, and §5 of the
   * design: the shared seed feeds `expectNoRowRewritten`, whose subject is
   * exactly this class of statement.
   *
   * The three negative rows are the predicate's three `exists` clauses, one
   * each: a delivery still outstanding is not a disagreement but a fan-out
   * mid-flight, an item with no adaptations at all decides nothing (the empty
   * guard the fold spells out and `bool_and` would answer `NULL` for), and an
   * item that is not `approved` was never stranded by this defect.
   */
  it("moves a stranded fan-out to the new status, and moves nothing else", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(PARTIAL_MIGRATION);
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let seeded: { stranded: string; midFlight: string; childless: string; draft: string };
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        // If the value were already admitted, "backfilled by this migration"
        // would be a lie and everything below would prove nothing. It also
        // pins the ORDER: a backfill written above the CHECK rewrite meets
        // this same constraint and rolls the migration back.
        const premature = await refusal(
          pool,
          "INSERT INTO organization (id, name, slug) VALUES ('org_premature', 'x', 'x')",
        );
        expect(premature).toBeNull();
        const brand = await pool.query(
          "INSERT INTO brands (org_id, name) VALUES ('org_premature', 'Brand') RETURNING id",
        );
        expect(
          await refusal(
            pool,
            "INSERT INTO content_items (org_id, brand_id, body, status, origin) VALUES ('org_premature', $1, 'x', 'partially_published', 'ai')",
            [brand.rows[0].id],
          ),
        ).toBe(CHECK_VIOLATION);

        const [stranded, midFlight, childless] = await seedFanOuts(pool, "org_partial", [
          ["published", "failed"],
          ["published", "queued"],
          [],
        ]);
        const [draft] = await seedFanOuts(
          pool,
          "org_partial_draft",
          [["published", "failed"]],
          "draft",
        );
        seeded = {
          stranded: stranded as string,
          midFlight: midFlight as string,
          childless: childless as string,
          draft: draft as string,
        };
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const statusOf = async (id: string) =>
          (await after.query("SELECT status FROM content_items WHERE id = $1", [id])).rows[0]
            ?.status;
        expect(await statusOf(seeded.stranded)).toBe("partially_published");
        expect(await statusOf(seeded.midFlight)).toBe("approved");
        expect(await statusOf(seeded.childless)).toBe("approved");
        expect(await statusOf(seeded.draft)).toBe("draft");
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  /**
   * THE ONE-DEFINITION RATCHET: the backfill's predicate and `nextItemStatus`
   * over the same rows, asserted equal on every one of them.
   *
   * The promotion rule has three callers and two of them are TypeScript; the
   * third is this UPDATE, the fold transcribed into SQL. A transcription is a
   * copy, and a copy drifts silently — the two answers are only ever compared
   * where somebody put them side by side, which is here.
   *
   * IN THIS FILE because only this tier has a database.
   * `schema-invariants.test.ts` never queries Postgres — it is a regex over
   * `migrations/*.sql` and a render of the schema — so it cannot run SQL over
   * rows at all.
   *
   * It catches the `exists`-vs-`bool_and` trap by construction: the empty
   * fan-out is in the table, and `bool_and` over an empty set is `NULL`.
   */
  it("gives the same answer as the fold over every fan-out up to three deliveries", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore(PARTIAL_MIGRATION);
    try {
      // 6 + 21 + 10 multisets, plus the empty fan-out. A number, so a helper
      // that quietly stopped generating one of the three groups would be a
      // failure here rather than a smaller matrix nobody noticed.
      expect(FAN_OUTS).toHaveLength(38);
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let itemIds: string[];
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        itemIds = await seedFanOuts(pool, "org_matrix", FAN_OUTS);
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);

      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const rows = await after.query<{ id: string; status: string }>(
          "SELECT id, status FROM content_items WHERE org_id = 'org_matrix'",
        );
        const backfilled = new Map(rows.rows.map((row) => [row.id, row.status]));
        // Every row seeded `approved`, so the SQL said `partially_published`
        // exactly where the row moved. The fold's other two verdicts are the
        // worker's business and deliberately outside this UPDATE's scope: it
        // repairs the status nothing could have written, not every status a
        // past bug could have left behind.
        const disagreements = FAN_OUTS.map((fanOut, index) => ({
          fanOut: fanOut.join("+") || "(no deliveries)",
          sql: backfilled.get(itemIds[index] as string) === "partially_published",
          fold: nextItemStatus(fanOut) === "partially_published",
        })).filter((row) => row.sql !== row.fold);
        expect(
          disagreements,
          "the backfill's SQL and `nextItemStatus` disagree about a fan-out:",
        ).toEqual([]);
        // And the ratchet is not vacuous from either end.
        expect(
          FAN_OUTS.filter((fanOut) => nextItemStatus(fanOut) === "partially_published"),
        ).not.toHaveLength(0);
        expect([...backfilled.values()].filter((status) => status === "approved")).not.toHaveLength(
          0,
        );
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("adds automatic knowledge indexing as opt-in to an existing database", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0051_flat_gwen_stacy");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let brandId!: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('auto_index_org', 'Test', 'auto-index-test')",
        );
        const brand = await pool.query<{ id: string }>(
          "INSERT INTO brands (org_id, name) VALUES ('auto_index_org', 'Brand') RETURNING id",
        );
        assert(brand.rows[0]);
        brandId = brand.rows[0].id;
        const absent = await pool.query<{ exists: string | null }>(
          "SELECT to_regclass('public.knowledge_auto_index')::text AS exists",
        );
        assert(absent.rows[0]);
        expect(absent.rows[0].exists).toBeNull();
      } finally {
        await pool.end();
      }
      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const existing = await after.query("SELECT * FROM knowledge_auto_index");
        expect(existing.rows).toEqual([]);
        const inserted = await after.query<{ enabled: boolean; last_attempt_at: Date | null }>(
          "INSERT INTO knowledge_auto_index (org_id, brand_id) VALUES ('auto_index_org', $1) RETURNING enabled, last_attempt_at",
          [brandId],
        );
        expect(inserted.rows).toEqual([{ enabled: false, last_attempt_at: null }]);
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("adds nullable news vectors to existing stories and enforces their provenance", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0056_free_phantom_reporter");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let itemId!: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('news_vector_org', 'Test', 'news-vector-test')",
        );
        const brand = await pool.query<{ id: string }>(
          "INSERT INTO brands (org_id, name) VALUES ('news_vector_org', 'Brand') RETURNING id",
        );
        assert(brand.rows[0]);
        const source = await pool.query<{ id: string }>(
          "INSERT INTO news_sources (org_id, brand_id, name, url) VALUES ('news_vector_org', $1, 'Feed', 'https://example.com/feed') RETURNING id",
          [brand.rows[0].id],
        );
        assert(source.rows[0]);
        const item = await pool.query<{ id: string }>(
          "INSERT INTO news_items (org_id, brand_id, source_id, title, url) VALUES ('news_vector_org', $1, $2, 'Existing story', 'https://example.com/story') RETURNING id",
          [brand.rows[0].id, source.rows[0].id],
        );
        assert(item.rows[0]);
        itemId = item.rows[0].id;
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const existing = await after.query(
          "SELECT title, embedding, embedding_model, embedding_dimensions FROM news_items WHERE id = $1",
          [itemId],
        );
        expect(existing.rows).toEqual([
          {
            title: "Existing story",
            embedding: null,
            embedding_model: null,
            embedding_dimensions: null,
          },
        ]);
        const constraint = await after.query<{ convalidated: boolean }>(
          "SELECT convalidated FROM pg_constraint WHERE conname = 'news_items_embedding_metadata_check'",
        );
        expect(constraint.rows).toEqual([{ convalidated: false }]);
        expect(
          await refusal(
            after,
            "UPDATE news_items SET embedding_model = 'gemini-embedding-001' WHERE id = $1",
            [itemId],
          ),
        ).toBe(CHECK_VIOLATION);
        const vector = `[${Array(768).fill(0).join(",")}]`;
        expect(
          await refusal(
            after,
            "UPDATE news_items SET embedding = $1::vector, embedding_model = 'gemini-embedding-001', embedding_dimensions = NULL WHERE id = $2",
            [vector, itemId],
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            after,
            "UPDATE news_items SET embedding = $1::vector, embedding_model = 'gemini-embedding-001', embedding_dimensions = 767 WHERE id = $2",
            [vector, itemId],
          ),
        ).toBe(CHECK_VIOLATION);
        await after.query(
          "UPDATE news_items SET embedding = $1::vector, embedding_model = 'gemini-embedding-001', embedding_dimensions = 768 WHERE id = $2",
          [vector, itemId],
        );
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("adds opt-in dated topic planning without changing existing plans or configs", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0061_dated_topic_planning");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let topicId!: string;
      let brandId!: string;
      let channelId!: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('topic_plan_org', 'Test', 'topic-plan-test')",
        );
        const brand = await pool.query<{ id: string }>(
          "INSERT INTO brands (org_id, name) VALUES ('topic_plan_org', 'Brand') RETURNING id",
        );
        brandId = brand.rows[0]?.id as string;
        const channel = await pool.query<{ id: string }>(
          "INSERT INTO channels (org_id, brand_id, platform, name, credentials_encrypted) VALUES ('topic_plan_org', $1, 'telegram', 'Main', 'blob') RETURNING id",
          [brandId],
        );
        channelId = channel.rows[0]?.id as string;
        const topic = await pool.query<{ id: string }>(
          "INSERT INTO topics (org_id, brand_id, title) VALUES ('topic_plan_org', $1, 'Existing idea') RETURNING id",
          [brandId],
        );
        topicId = topic.rows[0]?.id as string;
        await pool.query(
          "INSERT INTO autopilot_configs (org_id, brand_id, channel_ids, auto_suggest_topics) VALUES ('topic_plan_org', $1, '[]', true)",
          [brandId],
        );
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        expect(
          (
            await after.query("SELECT title, planned_date, priority FROM topics WHERE id = $1", [
              topicId,
            ])
          ).rows,
        ).toEqual([{ title: "Existing idea", planned_date: null, priority: 5 }]);
        expect(
          (
            await after.query(
              "SELECT auto_suggest_topics, auto_plan_topics, planning_daily_limit FROM autopilot_configs WHERE brand_id = $1",
              [brandId],
            )
          ).rows,
        ).toEqual([
          { auto_suggest_topics: true, auto_plan_topics: false, planning_daily_limit: 1 },
        ]);
        expect(
          await refusal(after, "UPDATE topics SET priority = 0 WHERE id = $1", [topicId]),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(after, "UPDATE topics SET priority = 11 WHERE id = $1", [topicId]),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            after,
            "UPDATE autopilot_configs SET planning_daily_limit = 6 WHERE brand_id = $1",
            [brandId],
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            after,
            "UPDATE autopilot_configs SET auto_plan_topics = true WHERE brand_id = $1",
            [brandId],
          ),
        ).toBe(CHECK_VIOLATION);
        await after.query(
          "UPDATE autopilot_configs SET channel_ids = $1::jsonb, auto_plan_topics = true, planning_daily_limit = 3 WHERE brand_id = $2",
          [JSON.stringify([channelId]), brandId],
        );
        await after.query(
          "UPDATE topics SET planned_date = '2026-10-11', priority = 1 WHERE id = $1",
          [topicId],
        );
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("adds a nullable first-party manual planning clock to existing configs", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0062_manual_topic_plan_cooldown");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let brandId!: string;
      let priorUpdatedAt!: Date;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('manual_plan_org', 'Test', 'manual-plan-test')",
        );
        const brand = await pool.query<{ id: string }>(
          "INSERT INTO brands (org_id, name) VALUES ('manual_plan_org', 'Brand') RETURNING id",
        );
        brandId = brand.rows[0]?.id as string;
        const config = await pool.query<{ updated_at: Date }>(
          "INSERT INTO autopilot_configs (org_id, brand_id, channel_ids, auto_suggest_topics) VALUES ('manual_plan_org', $1, '[]', true) RETURNING updated_at",
          [brandId],
        );
        priorUpdatedAt = config.rows[0]?.updated_at as Date;
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const config = await after.query<{
          auto_suggest_topics: boolean;
          last_manual_plan_at: Date | null;
          updated_at: Date;
        }>(
          "SELECT auto_suggest_topics, last_manual_plan_at, updated_at FROM autopilot_configs WHERE brand_id = $1",
          [brandId],
        );
        expect(config.rows).toEqual([
          {
            auto_suggest_topics: true,
            last_manual_plan_at: null,
            updated_at: priorUpdatedAt,
          },
        ]);
        const stamped = await after.query<{ last_manual_plan_at: Date }>(
          "UPDATE autopilot_configs SET last_manual_plan_at = clock_timestamp() WHERE brand_id = $1 RETURNING last_manual_plan_at",
          [brandId],
        );
        expect(stamped.rows[0]?.last_manual_plan_at).toBeInstanceOf(Date);
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("backfills existing member-brand access and rejects cross-organization grants", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0063_brand_access_grants");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let firstBrand!: string;
      let secondBrand!: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('grant_a', 'A', 'grant-a'), ('grant_b', 'B', 'grant-b')",
        );
        await pool.query(
          "INSERT INTO \"user\" (id, name, email) VALUES ('grant_user_a', 'A', 'a@grant.test'), ('grant_user_b', 'B', 'b@grant.test'), ('grant_manager_a', 'Manager', 'manager@grant.test')",
        );
        await pool.query(
          "INSERT INTO member (id, organization_id, user_id, role) VALUES ('grant_member_a', 'grant_a', 'grant_user_a', 'member'), ('grant_member_b', 'grant_b', 'grant_user_b', 'member'), ('grant_manager_a', 'grant_a', 'grant_manager_a', 'admin')",
        );
        firstBrand = (
          await pool.query<{ id: string }>(
            "INSERT INTO brands (org_id, name) VALUES ('grant_a', 'A brand') RETURNING id",
          )
        ).rows[0]?.id as string;
        secondBrand = (
          await pool.query<{ id: string }>(
            "INSERT INTO brands (org_id, name) VALUES ('grant_b', 'B brand') RETURNING id",
          )
        ).rows[0]?.id as string;
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const grants = await after.query<{ org_id: string; brand_id: string; member_id: string }>(
          "SELECT org_id, brand_id, member_id FROM brand_access ORDER BY org_id",
        );
        expect(grants.rows).toEqual([
          { org_id: "grant_a", brand_id: firstBrand, member_id: "grant_member_a" },
          { org_id: "grant_b", brand_id: secondBrand, member_id: "grant_member_b" },
        ]);
        await after.query("UPDATE member SET role = 'admin' WHERE id = 'grant_member_a'");
        await after.query("UPDATE member SET role = 'member' WHERE id = 'grant_member_a'");
        expect(
          (await after.query("SELECT 1 FROM brand_access WHERE member_id = 'grant_member_a'"))
            .rowCount,
        ).toBe(0);
        await after.query(
          "INSERT INTO \"user\" (id, name, email) VALUES ('grant_new_user', 'New', 'new@grant.test')",
        );
        await after.query(
          "INSERT INTO member (id, organization_id, user_id) VALUES ('grant_new_member', 'grant_a', 'grant_new_user')",
        );
        expect(
          (await after.query("SELECT 1 FROM brand_access WHERE member_id = 'grant_new_member'"))
            .rowCount,
        ).toBe(0);
        await expect(
          after.query(
            "INSERT INTO brand_access (org_id, brand_id, member_id) VALUES ('grant_a', $1, 'grant_member_b')",
            [firstBrand],
          ),
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          after.query(
            "INSERT INTO brand_access (org_id, brand_id, member_id) VALUES ('grant_a', $1, 'grant_new_member')",
            [secondBrand],
          ),
        ).rejects.toMatchObject({ code: "23503" });
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("rejects a paid relevance batch with another organization's brand", async () => {
    const fresh = await withFreshDatabase(url as string);
    try {
      await runMigrations(fresh.url);
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('recheck_fk_a', 'A', 'recheck-fk-a'), ('recheck_fk_b', 'B', 'recheck-fk-b')",
        );
        const brand = await pool.query<{ id: string }>(
          "INSERT INTO brands (org_id, name) VALUES ('recheck_fk_a', 'A brand') RETURNING id",
        );
        const brandId = brand.rows[0]?.id as string;
        const inserted = await pool.query<{ id: string }>(
          "INSERT INTO news_relevance_batches (org_id, brand_id, days, selected_count) VALUES ('recheck_fk_a', $1, 7, 1) RETURNING id",
          [brandId],
        );
        expect(inserted.rows).toHaveLength(1);
        await expect(
          pool.query(
            "INSERT INTO news_relevance_batches (org_id, brand_id, days, selected_count) VALUES ('recheck_fk_b', $1, 7, 1)",
            [brandId],
          ),
        ).rejects.toMatchObject({ code: "23503" });
        await expect(
          pool.query("UPDATE news_relevance_batches SET org_id = 'recheck_fk_b' WHERE id = $1", [
            inserted.rows[0]?.id,
          ]),
        ).rejects.toMatchObject({ code: "23503" });
      } finally {
        await pool.end();
      }
    } finally {
      await fresh.drop();
    }
  });

  it("keeps historical image revisions null while defaulting new posts to zero", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0064_amusing_unus");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let brandId!: string;
      let historicalId!: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('images_legacy', 'Images legacy', 'images-legacy')",
        );
        brandId = (
          await pool.query<{ id: string }>(
            "INSERT INTO brands (org_id, name) VALUES ('images_legacy', 'Legacy brand') RETURNING id",
          )
        ).rows[0]?.id as string;
        historicalId = (
          await pool.query<{ id: string }>(
            "INSERT INTO content_items (org_id, brand_id, body) VALUES ('images_legacy', $1, 'Historical body') RETURNING id",
            [brandId],
          )
        ).rows[0]?.id as string;
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const historical = await after.query<{ images_revision: number | null }>(
          "SELECT images_revision FROM content_items WHERE id = $1",
          [historicalId],
        );
        expect(historical.rows[0]?.images_revision).toBeNull();
        const inserted = await after.query<{ images_revision: number }>(
          "INSERT INTO content_items (org_id, brand_id, body) VALUES ('images_legacy', $1, 'New body') RETURNING images_revision",
          [brandId],
        );
        expect(inserted.rows[0]?.images_revision).toBe(0);
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("preserves existing topic and slot content while defaulting their new format metadata", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0081_topic_format_seo");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let topicId!: string;
      let slotId!: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        const oldColumns = await pool.query(
          "SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('topics', 'calendar_slots') AND column_name = 'seo_keywords'",
        );
        expect(oldColumns.rows).toHaveLength(0);
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('topic_format_old', 'Topic old', 'topic-format-old')",
        );
        const brand = await pool.query<{ id: string }>(
          "INSERT INTO brands (org_id, name) VALUES ('topic_format_old', 'Legacy brand') RETURNING id",
        );
        const brandId = brand.rows[0]?.id as string;
        const topic = await pool.query<{ id: string; updated_at: Date; revision: number }>(
          "INSERT INTO topics (org_id, brand_id, title, description, status) VALUES ('topic_format_old', $1, 'Reviewed topic', 'Known details', 'approved') RETURNING id, updated_at, revision",
          [brandId],
        );
        topicId = topic.rows[0]?.id as string;
        const slot = await pool.query<{ id: string }>(
          "INSERT INTO calendar_slots (org_id, brand_id, scheduled_at, brief, topic_id, topic_title, topic_description, topic_updated_at, topic_revision, channel_ids, content_type) VALUES ('topic_format_old', $1, now() + interval '1 day', 'Reviewed topic\\n\\nKnown details', $2, 'Reviewed topic', 'Known details', $3, $4, '[]'::jsonb, 'expert_article') RETURNING id",
          [brandId, topicId, topic.rows[0]?.updated_at, topic.rows[0]?.revision],
        );
        slotId = slot.rows[0]?.id as string;
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const topic = await after.query(
          "SELECT title, description, status, content_type, seo_keywords FROM topics WHERE id = $1",
          [topicId],
        );
        expect(topic.rows[0]).toMatchObject({
          title: "Reviewed topic",
          description: "Known details",
          status: "approved",
          content_type: "social_post",
          seo_keywords: [],
        });
        const slot = await after.query(
          "SELECT brief, topic_id, content_type, seo_keywords FROM calendar_slots WHERE id = $1",
          [slotId],
        );
        expect(slot.rows[0]).toMatchObject({
          topic_id: topicId,
          content_type: "expert_article",
          seo_keywords: [],
        });
        expect(slot.rows[0]?.brief).toContain("Reviewed topic");
        const constraints = await after.query<{ conname: string; convalidated: boolean }>(
          "SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('calendar_slots_seo_keywords_check', 'topics_content_type_check', 'topics_seo_keywords_check') ORDER BY conname",
        );
        expect(constraints.rows).toEqual([
          { conname: "calendar_slots_seo_keywords_check", convalidated: false },
          { conname: "topics_content_type_check", convalidated: false },
          { conname: "topics_seo_keywords_check", convalidated: false },
        ]);
        expect(
          await refusal(after, "UPDATE topics SET content_type = 'not_a_format' WHERE id = $1", [
            topicId,
          ]),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            after,
            "UPDATE topics SET seo_keywords = '[\"term\"]'::jsonb WHERE id = $1",
            [topicId],
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            after,
            "UPDATE calendar_slots SET content_type = 'social_post', seo_keywords = '[\"term\"]'::jsonb WHERE id = $1",
            [slotId],
          ),
        ).toBe(CHECK_VIOLATION);
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("builds the recent usage index while upgrading an existing ledger", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0082_exotic_warstar");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        const missing = await pool.query(
          "SELECT 1 FROM pg_indexes WHERE indexname = 'usage_ledger_org_recent_idx'",
        );
        expect(missing.rowCount).toBe(0);
      } finally {
        await pool.end();
      }
      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const built = await after.query<{ indisvalid: boolean; indexdef: string }>(
          `SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS indexdef
           FROM pg_index i WHERE i.indexrelid = to_regclass('public.usage_ledger_org_recent_idx')`,
        );
        expect(built.rows[0]?.indisvalid).toBe(true);
        expect(built.rows[0]?.indexdef).toContain("created_at DESC");
        expect(built.rows[0]?.indexdef).toContain("id DESC");
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("adds the topic block check without scanning existing topics at startup", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0083_purple_patriot");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let topicId!: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('topic_block_old', 'Topic block old', 'topic-block-old')",
        );
        const brand = await pool.query<{ id: string }>(
          "INSERT INTO brands (org_id, name) VALUES ('topic_block_old', 'Legacy brand') RETURNING id",
        );
        const topic = await pool.query<{ id: string }>(
          "INSERT INTO topics (org_id, brand_id, title, status) VALUES ('topic_block_old', $1, 'Legacy approved', 'approved') RETURNING id",
          [brand.rows[0]?.id],
        );
        topicId = topic.rows[0]?.id as string;
      } finally {
        await pool.end();
      }
      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const topic = await after.query(
          "SELECT status, blocked_at, block_reason FROM topics WHERE id = $1",
          [topicId],
        );
        expect(topic.rows[0]).toEqual({ status: "approved", blocked_at: null, block_reason: null });
        const constraint = await after.query<{ convalidated: boolean }>(
          "SELECT convalidated FROM pg_constraint WHERE conname = 'topics_block_state_check'",
        );
        expect(constraint.rows).toEqual([{ convalidated: false }]);
        expect(
          await refusal(after, "UPDATE topics SET blocked_at = now() WHERE id = $1", [topicId]),
        ).toBe(CHECK_VIOLATION);
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("preserves existing image slots and feed snapshots with centered alignment", async () => {
    const fresh = await withFreshDatabase(url as string);
    const before = await migrationsFolderBefore("0085_fixed_blob");
    try {
      const pool = new pg.Pool({ connectionString: fresh.url, max: 1 });
      let itemId!: string;
      let entryId!: string;
      let brandId!: string;
      let mediaId!: string;
      try {
        await migrate(drizzle(pool), { migrationsFolder: before });
        const missing = await pool.query(
          "SELECT table_name FROM information_schema.columns WHERE table_name IN ('content_image_slots', 'feed_entry_images') AND column_name = 'alignment'",
        );
        expect(missing.rows).toHaveLength(0);
        await pool.query(
          "INSERT INTO organization (id, name, slug) VALUES ('alignment_old', 'Alignment old', 'alignment-old')",
        );
        brandId = (
          await pool.query<{ id: string }>(
            "INSERT INTO brands (org_id, name) VALUES ('alignment_old', 'Legacy brand') RETURNING id",
          )
        ).rows[0]?.id as string;
        itemId = (
          await pool.query<{ id: string }>(
            "INSERT INTO content_items (org_id, brand_id, title, body) VALUES ('alignment_old', $1, 'Legacy article', 'First paragraph\n\nSecond paragraph') RETURNING id",
            [brandId],
          )
        ).rows[0]?.id as string;
        mediaId = (
          await pool.query<{ id: string }>(
            "INSERT INTO media_assets (org_id, brand_id, name, width, height, byte_size) VALUES ('alignment_old', $1, 'Legacy image', 10, 10, 200) RETURNING id",
            [brandId],
          )
        ).rows[0]?.id as string;
        const feedId = (
          await pool.query<{ id: string }>(
            "INSERT INTO brand_feeds (org_id, brand_id, public_token) VALUES ('alignment_old', $1, 'alignment-old-token') RETURNING id",
            [brandId],
          )
        ).rows[0]?.id as string;
        entryId = (
          await pool.query<{ id: string }>(
            "INSERT INTO feed_entries (org_id, brand_id, feed_id, content_item_id, title, body) VALUES ('alignment_old', $1, $2, $3, 'Legacy article', 'First paragraph\n\nSecond paragraph') RETURNING id",
            [brandId, feedId, itemId],
          )
        ).rows[0]?.id as string;
        await pool.query(
          "INSERT INTO content_image_slots (org_id, brand_id, content_item_id, media_id, after_paragraph, alt) VALUES ('alignment_old', $1, $2, $3, 0, 'Legacy image')",
          [brandId, itemId, mediaId],
        );
        await pool.query(
          "INSERT INTO feed_entry_images (org_id, brand_id, feed_entry_id, media_id, after_paragraph, alt, position) VALUES ('alignment_old', $1, $2, $3, 0, 'Legacy image', 0)",
          [brandId, entryId, mediaId],
        );
      } finally {
        await pool.end();
      }

      await runMigrations(fresh.url);
      const after = new pg.Pool({ connectionString: fresh.url, max: 1 });
      try {
        const slots = await after.query<{ after_paragraph: number; alignment: string }>(
          "SELECT after_paragraph, alignment FROM content_image_slots WHERE content_item_id = $1 ORDER BY after_paragraph",
          [itemId],
        );
        const snapshots = await after.query<{ after_paragraph: number; alignment: string }>(
          "SELECT after_paragraph, alignment FROM feed_entry_images WHERE feed_entry_id = $1 ORDER BY after_paragraph",
          [entryId],
        );
        expect(slots.rows).toEqual([{ after_paragraph: 0, alignment: "center" }]);
        expect(snapshots.rows).toEqual([{ after_paragraph: 0, alignment: "center" }]);
        await after.query(
          "INSERT INTO content_image_slots (org_id, brand_id, content_item_id, media_id, after_paragraph, alt) VALUES ('alignment_old', $1, $2, $3, 1, 'New image')",
          [brandId, itemId, mediaId],
        );
        await after.query(
          "INSERT INTO feed_entry_images (org_id, brand_id, feed_entry_id, media_id, after_paragraph, alt, position) VALUES ('alignment_old', $1, $2, $3, 1, 'New image', 1)",
          [brandId, entryId, mediaId],
        );
        expect(
          (
            await after.query<{ alignment: string }>(
              "SELECT alignment FROM content_image_slots WHERE content_item_id = $1 ORDER BY after_paragraph",
              [itemId],
            )
          ).rows.map((row) => row.alignment),
        ).toEqual(["center", "center"]);
        expect(
          (
            await after.query<{ alignment: string }>(
              "SELECT alignment FROM feed_entry_images WHERE feed_entry_id = $1 ORDER BY after_paragraph",
              [entryId],
            )
          ).rows.map((row) => row.alignment),
        ).toEqual(["center", "center"]);
        expect(
          await refusal(
            after,
            "UPDATE content_image_slots SET alignment = 'diagonal' WHERE content_item_id = $1",
            [itemId],
          ),
        ).toBe(CHECK_VIOLATION);
        expect(
          await refusal(
            after,
            "UPDATE feed_entry_images SET alignment = 'diagonal' WHERE feed_entry_id = $1",
            [entryId],
          ),
        ).toBe(CHECK_VIOLATION);
        const checks = await after.query<{ convalidated: boolean }>(
          "SELECT convalidated FROM pg_constraint WHERE conname IN ('content_image_slots_alignment_check', 'feed_entry_images_alignment_check') ORDER BY conname",
        );
        expect(checks.rows).toEqual([{ convalidated: false }, { convalidated: false }]);
      } finally {
        await after.end();
      }
    } finally {
      await fs.rm(before, { recursive: true, force: true });
      await fresh.drop();
    }
  });
});
