import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Vertex and compatible provider upgrade", () => {
  it("retains populated keys, defaults and ledger rows without scanning widened checks", async () => {
    const pool = new pg.Pool({ connectionString: url });
    const client = await pool.connect();
    const namespace = `extended_providers_${randomUUID().replaceAll("-", "")}`;
    const tables = ["ai_credentials", "organization_ai_text_settings", "usage_ledger"];
    try {
      await client.query(`CREATE SCHEMA "${namespace}"`);
      await client.query(`SET search_path TO "${namespace}"`);
      for (const table of tables) {
        await client.query(`CREATE TABLE ${table} (id text PRIMARY KEY, provider text NOT NULL, retained text,
          CONSTRAINT ${table}_provider_check CHECK (provider IN ('google','openrouter','openai','anthropic','deepseek')));
          INSERT INTO ${table} VALUES ('old-google','google','existing encrypted secret/model/cost'),
            ('old-openai','openai',NULL);`);
      }
      const before = await Promise.all(
        tables.map(
          async (table) => (await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
        ),
      );
      await client.query("BEGIN");
      await client.query(
        readFileSync(
          new URL("../migrations/0120_vertex_compatible_providers.sql", import.meta.url),
          "utf8",
        ),
      );
      await client.query("COMMIT");
      for (const [index, table] of tables.entries()) {
        expect((await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows).toEqual(
          before[index],
        );
        expect(
          (
            await client.query(
              "SELECT convalidated FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname=$2",
              [namespace, `${table}_provider_check`],
            )
          ).rows,
        ).toEqual([{ convalidated: false }]);
        for (const provider of ["vertex", "openai_compatible"])
          await client.query(`INSERT INTO ${table} VALUES ($1,$1,NULL)`, [provider]);
        await expect(
          client.query(`UPDATE ${table} SET provider='unsupported' WHERE id='old-google'`),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${table}_provider_check`);
      }
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      client.release();
      await pool.end();
    }
  });
});
