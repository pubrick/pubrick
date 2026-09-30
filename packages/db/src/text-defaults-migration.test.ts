import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("populated text selection upgrade", () => {
  it("preserves encrypted keys and old records, seeds the oldest model, and defers CHECK scans", async () => {
    const pool = new pg.Pool({ connectionString: url });
    const client = await pool.connect();
    const namespace = `text_upgrade_${randomUUID().replaceAll("-", "")}`;
    const orgId = `upgrade-${randomUUID()}`;
    const constraints = [
      ["autopilot_manual_attempts", "decision", "autopilot_manual_attempts_decision_check"],
      ["autopilot_scan_events", "decision", "autopilot_scan_events_decision_check"],
      ["claim_reviews", "error_code", "claim_reviews_error_code_check"],
      ["news_relevance_batch_items", "error_code", "news_relevance_batch_items_error_code_check"],
      ["news_relevance_batches", "error_code", "news_relevance_batches_error_code_check"],
      ["news_items", "relevance_error_code", "news_items_relevance_error_code_check"],
      ["topic_suggestion_requests", "error_code", "topic_suggestion_requests_error_code_check"],
    ] as const;
    try {
      await client.query(
        "INSERT INTO public.organization (id,name,slug,created_at) VALUES ($1,$1,$1,now())",
        [orgId],
      );
      await client.query(`CREATE SCHEMA "${namespace}"`);
      await client.query(`SET search_path TO "${namespace}",public`);
      await client.query(`CREATE TABLE ai_credentials (id uuid PRIMARY KEY, org_id text NOT NULL, provider text NOT NULL, credentials_encrypted text NOT NULL, default_model text, created_at timestamp NOT NULL);
        CREATE TABLE pipeline_runs (id text PRIMARY KEY, input jsonb NOT NULL);
        INSERT INTO pipeline_runs VALUES ('old-run', '{"kind":"brief","text":"Preserve"}');`);
      for (const [table, column, constraint] of constraints) {
        const value = column === "decision" ? "disabled" : "model_failed";
        // These are fixed schema identifiers, never request input.
        await client.query(
          `CREATE TABLE "${table}" (id text PRIMARY KEY, "${column}" text, CONSTRAINT "${constraint}" CHECK ("${column}" = '${value}')); INSERT INTO "${table}" VALUES ('old-row','${value}')`,
        );
      }
      await client.query(
        "INSERT INTO ai_credentials VALUES ($1,$2,'openai','opaque-first','legacy-first','2026-01-01'),($3,$2,'google','opaque-second',NULL,'2026-01-02')",
        [randomUUID(), orgId, randomUUID()],
      );
      const keys = (
        await client.query(
          "SELECT id,org_id,provider,credentials_encrypted,default_model,created_at FROM ai_credentials ORDER BY id",
        )
      ).rows;
      const run = (await client.query("SELECT * FROM pipeline_runs")).rows[0];
      await client.query("BEGIN");
      await client.query(
        readFileSync(
          new URL("../migrations/0118_text_defaults_and_pins.sql", import.meta.url),
          "utf8",
        ),
      );
      await client.query("COMMIT");
      expect(
        (
          await client.query(
            "SELECT id,org_id,provider,credentials_encrypted,default_model,created_at FROM ai_credentials ORDER BY id",
          )
        ).rows,
      ).toEqual(keys);
      expect((await client.query("SELECT * FROM pipeline_runs")).rows).toEqual([
        { ...run, text_selection: null },
      ]);
      expect((await client.query("SELECT * FROM organization_ai_text_settings")).rows).toEqual([
        { org_id: orgId, provider: "openai", model: "legacy-first", revision: 1 },
      ]);
      expect((await client.query("SELECT revision FROM ai_credentials")).rows).toEqual([
        { revision: 1 },
        { revision: 1 },
      ]);
      for (const [table, column, constraint] of constraints) {
        expect(
          (
            await client.query(
              "SELECT convalidated FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname=$2",
              [namespace, constraint],
            )
          ).rows,
        ).toEqual([{ convalidated: false }]);
        await client.query(`UPDATE "${table}" SET "${column}"=$1`, [
          column === "decision" ? "no_ai_key" : "configuration_changed",
        ]);
        await expect(
          client.query(`UPDATE "${table}" SET "${column}"='unsupported'`),
        ).rejects.toMatchObject({ code: "23514" });
      }
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await client.query("DELETE FROM public.organization WHERE id=$1", [orgId]);
      client.release();
      await pool.end();
    }
  });
});
