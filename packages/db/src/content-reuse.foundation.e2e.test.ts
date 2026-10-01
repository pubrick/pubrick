import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

const baseUrl = process.env.TEST_DATABASE_URL;
const migration = "0127_content_reuse_foundation";
const digest = "a".repeat(64);
const accepted = "2026-10-01T09:00:00Z";
describe.skipIf(!baseUrl)("content reuse database foundation", () => {
  let database: string | undefined;
  let pool: pg.Pool;
  let legacy: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    if (!baseUrl) throw new Error("Missing disposable database URL");
    const parsed = new URL(baseUrl);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    )
      throw new Error("Reuse foundation requires a loopback disposable PostgreSQL server");
    const name = `pubrick_reuse_foundation_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      database = name;
    } finally {
      await admin.end();
    }
    parsed.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 2 });
    const folder = await mkdtemp(path.join(tmpdir(), "pubrick-reuse-upgrade-"));
    try {
      const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
      await mkdir(path.join(folder, "meta"));
      const journalPath = path.join(folder, "meta/_journal.json");
      const journal = JSON.parse(
        await readFile(path.join(source, "meta/_journal.json"), "utf8"),
      ) as {
        entries: { tag: string }[];
      };
      const cut = journal.entries.findIndex((entry) => entry.tag === migration);
      if (cut < 0) throw new Error("Missing reviewed reuse migration");
      journal.entries = journal.entries.slice(0, cut);
      await writeFile(journalPath, JSON.stringify(journal));
      for (const entry of journal.entries)
        await writeFile(
          path.join(folder, `${entry.tag}.sql`),
          await readFile(path.join(source, `${entry.tag}.sql`)),
        );
      await migrate(drizzle(pool), { migrationsFolder: folder });
      legacy = await fixture();
      await runMigrations(parsed.toString());
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
  afterAll(async () => {
    await pool?.end();
    if (!database) return;
    if (!/^pubrick_reuse_foundation_[a-f0-9]{32}$/.test(database))
      throw new Error("Unowned database");
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  async function insert(table: string, row: Record<string, unknown>) {
    return pool.query(
      `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map((_, i) => `$${i + 1}`)
        .join(",")}) RETURNING *`,
      Object.values(row),
    );
  }
  async function fixture() {
    const orgId = `reuse-${randomUUID()}`;
    await insert("organization", { id: orgId, name: "Synthetic", slug: orgId });
    const brand = await insert("brands", { org_id: orgId, name: "Synthetic" });
    const brandId = brand.rows[0].id as string;
    const source = await insert("content_items", {
      org_id: orgId,
      brand_id: brandId,
      body: "Original synthetic source",
      origin: "external",
      requires_imported_review: true,
    });
    const run = await insert("pipeline_runs", {
      org_id: orgId,
      brand_id: brandId,
      input: JSON.stringify({
        kind: "source",
        material: "Original synthetic source",
        sourceUrl: null,
      }),
      status: "failed",
    });
    return {
      orgId,
      brandId,
      sourceId: source.rows[0].id as string,
      runId: run.rows[0].id as string,
    };
  }
  function operation(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      org_id: f.orgId,
      brand_id: f.brandId,
      operation: "reuse",
      idempotency_key: "synthetic-key",
      request_hash: digest,
      hash_version: "parsed-dto-v1",
      root_source_id: f.sourceId,
      root_source_revision: 0,
      request_target_kind: "content",
      request_target_id: f.sourceId,
      result_run_id: f.runId,
      consenting_actor_id: "opaque-better-auth-actor",
      consent_version: "byok-paid-generation-v1",
      accepted_at: accepted,
    };
  }
  function lineage(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      org_id: f.orgId,
      brand_id: f.brandId,
      derived_run_id: f.runId,
      source_content_id: f.sourceId,
      source_revision: 0,
      source_title: "Original title",
      source_digest: digest,
      source_origin: "external",
      accepted_at: accepted,
    };
  }
  async function stored(table: string, column: string, id: string) {
    const row = await pool.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [id]);
    return row.rows[0];
  }
  it("upgrades populated legacy source runs without rewriting input or fabricating lineage", async () => {
    expect((await stored("pipeline_runs", "id", legacy.runId)).input).toEqual({
      kind: "source",
      material: "Original synthetic source",
      sourceUrl: null,
    });
    expect((await pool.query("SELECT count(*)::int AS n FROM run_source_lineage")).rows[0].n).toBe(
      0,
    );
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM content_reuse_operations")).rows[0].n,
    ).toBe(0);
  });
  it("retains unique lifetime replay identities separately for reuse and reuse-retry", async () => {
    const f = await fixture();
    const row = operation(f);
    await insert("content_reuse_operations", row);
    await expect(insert("content_reuse_operations", row)).rejects.toMatchObject({
      code: "23505",
      constraint: "content_reuse_operations_replay_idx",
    });
    await insert("content_reuse_operations", {
      ...row,
      operation: "reuse-retry",
      request_target_kind: "run",
      request_target_id: randomUUID(),
    });
  });
  it("rejects cross-tenant brand ownership and mismatched scoped run attribution", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      insert("content_reuse_operations", { ...operation(f), brand_id: other.brandId }),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insert("run_source_lineage", { ...lineage(f), brand_id: other.brandId }),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insert("run_source_lineage", { ...lineage(f), derived_run_id: other.runId }),
    ).rejects.toMatchObject({ code: "23503", constraint: "run_source_lineage_run_fk" });
  });
  it("proves every new CHECK by exact constraint on otherwise valid rows", async () => {
    const f = await fixture();
    const auditCases: [string, Record<string, unknown>][] = [
      ["operation", { operation: "clone" }],
      ["request_target_kind", { request_target_kind: "url" }],
      ["target", { request_target_id: randomUUID() }],
      ["key", { idempotency_key: "short" }],
      ["hash", { request_hash: "not-a-digest" }],
      ["hash", { hash_version: "unreviewed-v2" }],
      ["revision", { root_source_revision: -1 }],
      ["consent", { consenting_actor_id: "" }],
      ["consent", { consenting_actor_id: "a".repeat(256) }],
      ["consent", { consent_version: "free" }],
    ];
    for (const [name, invalid] of auditCases)
      await expect(
        insert("content_reuse_operations", { ...operation(f), ...invalid }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: `content_reuse_operations_${name}_check`,
      });
    const lineageCases: [string, Record<string, unknown>][] = [
      ["revision", { source_revision: -1 }],
      ["digest", { source_digest: "wrong" }],
      ["source_origin", { source_origin: "cloned-human" }],
      ["redaction", { source_digest: null }],
      ["redaction", { source_origin: null }],
      ["redaction", { source_redacted_at: accepted }],
    ];
    for (const [name, invalid] of lineageCases)
      await expect(
        insert("run_source_lineage", { ...lineage(f), ...invalid }),
      ).rejects.toMatchObject({ code: "23514", constraint: `run_source_lineage_${name}_check` });
    await expect(
      insert("content_reuse_operations", { ...operation(f), consent_version: null }),
    ).rejects.toMatchObject({ code: "23502" });
    await insert("content_reuse_operations", operation(f));
    await insert("run_source_lineage", { ...lineage(f), source_title: null });
  });
  it("freezes every operation audit field including target kind and UUID", async () => {
    const f = await fixture();
    const saved = (await insert("content_reuse_operations", operation(f))).rows[0];
    for (const [field, value] of Object.entries({
      id: randomUUID(),
      org_id: "another-org",
      brand_id: randomUUID(),
      hash_version: "changed",
      consent_version: "changed",
      request_target_kind: "run",
      request_target_id: randomUUID(),
      root_source_id: randomUUID(),
      root_source_revision: 1,
      result_run_id: randomUUID(),
      request_hash: "b".repeat(64),
      idempotency_key: "another-key",
      operation: "reuse-retry",
      consenting_actor_id: "other",
      accepted_at: "2026-10-01T10:00:00Z",
    }))
      await expect(
        pool.query(`UPDATE content_reuse_operations SET ${field}=$1 WHERE id=$2`, [
          value,
          saved.id,
        ]),
      ).rejects.toMatchObject({ code: "23514", message: "Reuse operation audit is immutable" });
    await pool.query("UPDATE content_reuse_operations SET request_hash=request_hash WHERE id=$1", [
      saved.id,
    ]);
  });
  it("permits only one-way complete erasure while preserving immutable source audit", async () => {
    const f = await fixture();
    await insert("run_source_lineage", lineage(f));
    for (const [field, value] of Object.entries({
      org_id: "another-org",
      brand_id: randomUUID(),
      derived_run_id: randomUUID(),
      source_content_id: randomUUID(),
      source_revision: 1,
      source_title: "Rewritten",
      source_digest: "b".repeat(64),
      source_origin: "human",
      accepted_at: "2026-10-01T10:00:00Z",
    }))
      await expect(
        pool.query(`UPDATE run_source_lineage SET ${field}=$1 WHERE derived_run_id=$2`, [
          value,
          f.runId,
        ]),
      ).rejects.toMatchObject({
        code: "23514",
        message: ["source_title", "source_digest", "source_origin"].includes(field)
          ? "Reuse source snapshot is immutable"
          : "Reuse lineage identity is immutable",
      });
    await pool.query(
      "UPDATE run_source_lineage SET source_title=NULL,source_digest=NULL,source_origin=NULL,source_redacted_at=$1 WHERE derived_run_id=$2",
      ["2026-10-01T10:00:00Z", f.runId],
    );
    const erased = await stored("run_source_lineage", "derived_run_id", f.runId);
    expect(erased).toMatchObject({
      source_content_id: f.sourceId,
      source_revision: 0,
      source_title: null,
      source_digest: null,
      source_origin: null,
    });
    expect(erased.source_redacted_at).toBeInstanceOf(Date);
    for (const [field, value] of Object.entries({
      source_redacted_at: null,
      source_title: "Recovered",
      source_content_id: randomUUID(),
      source_redacted_at_new: "2026-10-01T11:00:00Z",
    })) {
      const column = field === "source_redacted_at_new" ? "source_redacted_at" : field;
      await expect(
        pool.query(`UPDATE run_source_lineage SET ${column}=$1 WHERE derived_run_id=$2`, [
          value,
          f.runId,
        ]),
      ).rejects.toMatchObject({
        code: "23514",
        message:
          field === "source_content_id"
            ? "Reuse lineage identity is immutable"
            : "Reuse source erasure is terminal",
      });
    }
    // This complete resurrection would satisfy every CHECK without the terminal trigger.
    await expect(
      pool.query(
        "UPDATE run_source_lineage SET source_redacted_at=NULL,source_title=$1,source_digest=$2,source_origin='external' WHERE derived_run_id=$3",
        ["Original title", digest, f.runId],
      ),
    ).rejects.toMatchObject({ code: "23514", message: "Reuse source erasure is terminal" });
  });
  it("keeps independent run lineage and replay audit when source or result is removed", async () => {
    const f = await fixture();
    await insert("run_source_lineage", lineage(f));
    const op = (await insert("content_reuse_operations", operation(f))).rows[0];
    await pool.query("DELETE FROM content_items WHERE id=$1", [f.sourceId]);
    expect(await stored("run_source_lineage", "derived_run_id", f.runId)).toBeDefined();
    expect(await stored("pipeline_runs", "id", f.runId)).toBeDefined();
    await pool.query("DELETE FROM pipeline_runs WHERE id=$1", [f.runId]);
    expect(await stored("run_source_lineage", "derived_run_id", f.runId)).toBeUndefined();
    expect(await stored("content_reuse_operations", "id", op.id)).toEqual(op);
  });
  it("cleans only owning brand or tenant cascades and stores no duplicate source body", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const item of [f, other]) {
      await insert("run_source_lineage", lineage(item));
      await insert("content_reuse_operations", operation(item));
    }
    await pool.query("DELETE FROM brands WHERE id=$1", [f.brandId]);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM content_reuse_operations WHERE org_id=$1",
          [f.orgId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await stored("run_source_lineage", "derived_run_id", other.runId)).toBeDefined();
    await pool.query("DELETE FROM organization WHERE id=$1", [other.orgId]);
    expect(await stored("run_source_lineage", "derived_run_id", other.runId)).toBeUndefined();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM content_reuse_operations WHERE org_id=$1",
          [other.orgId],
        )
      ).rows[0].n,
    ).toBe(0);
    const columns = await pool.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('content_reuse_operations','run_source_lineage')",
    );
    expect(
      columns.rows.filter((row) =>
        ["body", "material", "input", "request", "result", "title"].includes(row.column_name),
      ),
    ).toEqual([]);
    expect(
      columns.rows.filter(
        (row) =>
          row.table_name === "content_reuse_operations" && row.column_name === "source_digest",
      ),
    ).toEqual([]);
  });
});
