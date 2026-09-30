import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("direct provider CHECK upgrade", () => {
  it("preserves populated old rows, avoids validation scans and checks new writes", async () => {
    const pool = new pg.Pool({ connectionString: url });
    const client = await pool.connect();
    const namespace = `providers_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA "${namespace}"`);
      await client.query(`SET search_path TO "${namespace}"`);
      // Only these two CHECKs change. A bounded schema fixture isolates their
      // upgrade from other tests without replaying unrelated historical DDL.
      await client.query(`CREATE TABLE ai_credentials (id text PRIMARY KEY, provider text NOT NULL,
        credentials_encrypted text NOT NULL, default_model text,
        CONSTRAINT ai_credentials_provider_check CHECK (provider IN ('google', 'openrouter')));
        CREATE TABLE usage_ledger (id text PRIMARY KEY, provider text NOT NULL, cost_usd numeric,
        CONSTRAINT usage_ledger_provider_check CHECK (provider IN ('google', 'openrouter')));
        INSERT INTO ai_credentials VALUES ('old-google', 'google', 'opaque-encrypted-blob', 'old-model'),
          ('old-router', 'openrouter', 'other-opaque-blob', NULL);
        INSERT INTO usage_ledger VALUES ('old-google', 'google', 0.001), ('old-router', 'openrouter', NULL);`);
      const keysBefore = (await client.query("SELECT * FROM ai_credentials ORDER BY id")).rows;
      const ledgerBefore = (await client.query("SELECT * FROM usage_ledger ORDER BY id")).rows;
      const sql = readFileSync(
        new URL("../migrations/0117_direct_llm_providers.sql", import.meta.url),
        "utf8",
      );
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      expect((await client.query("SELECT * FROM ai_credentials ORDER BY id")).rows).toEqual(
        keysBefore,
      );
      expect((await client.query("SELECT * FROM usage_ledger ORDER BY id")).rows).toEqual(
        ledgerBefore,
      );
      const checks = await client.query(
        `SELECT convalidated FROM pg_constraint
        WHERE connamespace = $1::regnamespace AND conname IN
        ('ai_credentials_provider_check', 'usage_ledger_provider_check')`,
        [namespace],
      );
      expect(checks.rows).toEqual([{ convalidated: false }, { convalidated: false }]);
      for (const provider of ["openai", "anthropic", "deepseek"]) {
        await client.query("INSERT INTO ai_credentials VALUES ($1, $1, 'new-opaque-blob', NULL)", [
          provider,
        ]);
        await client.query("INSERT INTO usage_ledger VALUES ($1, $1, NULL)", [provider]);
      }
      for (const table of ["ai_credentials", "usage_ledger"]) {
        await expect(
          client.query(`UPDATE ${table} SET provider = 'unsupported' WHERE id = 'old-google'`),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await client.query(
        "ALTER TABLE ai_credentials VALIDATE CONSTRAINT ai_credentials_provider_check",
      );
      await client.query(
        "ALTER TABLE usage_ledger VALIDATE CONSTRAINT usage_ledger_provider_check",
      );
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      client.release();
      await pool.end();
    }
  });
});
