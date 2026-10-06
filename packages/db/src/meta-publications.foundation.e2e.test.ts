import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

const baseUrl = process.env.TEST_DATABASE_URL;
const migrationTag = "0135_meta_publication_stages";
const input = { version: 1, platform: "threads", text: "Exact reviewed + text & punctuation" };
const jpeg = {
  mediaId: "00000000-0000-4000-8000-000000000005",
  sha256: "a".repeat(64),
  mimeType: "image/jpeg",
  width: 1080,
  height: 1080,
  byteSize: 12345,
};

describe.skipIf(!baseUrl)("Meta checkpoint foundation and populated upgrade on PostgreSQL", () => {
  let pool: pg.Pool;
  let database: string | undefined;
  let directory: string | undefined;
  let predecessorWhen: number;
  let migrationWhen: number;
  let oldChannelId: string;
  let oldAdaptationId: string;
  let oldReceiptId: string;
  let before: unknown[];

  beforeAll(async () => {
    if (!baseUrl) throw new Error("Missing disposable database URL");
    const parsed = new URL(baseUrl);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      !/^\/pubrick_.*_test$/.test(parsed.pathname)
    )
      throw new Error("Meta foundation requires loopback disposable pubrick_*_test database");
    const name = `pubrick_meta_foundation_${randomUUID().replaceAll("-", "")}_test`;
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      database = name;
    } finally {
      await admin.end();
    }
    parsed.pathname = `/${name}`;
    const connectionString = parsed.toString();
    pool = new pg.Pool({ connectionString, max: 4 });
    const folder = new URL("../migrations/", import.meta.url);
    const journal = JSON.parse(
      await fs.readFile(new URL("meta/_journal.json", folder), "utf8"),
    ) as {
      entries: Array<{ tag: string; when: number }>;
      [key: string]: unknown;
    };
    const cut = journal.entries.findIndex((entry) => entry.tag === migrationTag);
    if (cut < 1) throw new Error("Meta checkpoint migration or predecessor is missing");
    const predecessor = journal.entries[cut - 1];
    const checkpoint = journal.entries[cut];
    if (!predecessor || !checkpoint) throw new Error("Meta migration chain is incomplete");
    expect(predecessor.tag).toMatch(/^0134_/);
    predecessorWhen = predecessor.when;
    migrationWhen = checkpoint.when;
    directory = await fs.mkdtemp(path.join(tmpdir(), "pubrick-meta-migration-"));
    await fs.mkdir(path.join(directory, "meta"));
    for (const entry of journal.entries.slice(0, cut))
      await fs.copyFile(
        new URL(`${entry.tag}.sql`, folder),
        path.join(directory, `${entry.tag}.sql`),
      );
    await fs.writeFile(
      path.join(directory, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }),
    );
    await migrate(drizzle(pool), { migrationsFolder: directory });
    const last = await pool.query(
      "SELECT max(created_at)::text AS created_at FROM drizzle.__drizzle_migrations",
    );
    expect(last.rows[0]?.created_at).toBe(String(predecessorWhen));
    expect(
      (await pool.query("SELECT to_regclass('public.meta_publication_stages') AS target")).rows[0]
        ?.target,
    ).toBeNull();
    const oldOrg = `meta-legacy-${randomUUID()}`;
    const oldBrandId = randomUUID();
    oldChannelId = randomUUID();
    oldAdaptationId = randomUUID();
    oldReceiptId = randomUUID();
    const oldContentId = randomUUID();
    await pool.query("INSERT INTO organization(id,name,slug) VALUES ($1,'Legacy', $1)", [oldOrg]);
    await pool.query("INSERT INTO brands(id,org_id,name) VALUES ($1,$2,'Legacy brand')", [
      oldBrandId,
      oldOrg,
    ]);
    await pool.query(
      "INSERT INTO channels(id,org_id,brand_id,platform,name,credentials_encrypted) VALUES ($1,$2,$3,'telegram','Legacy channel','unchanged-opaque-credentials')",
      [oldChannelId, oldOrg, oldBrandId],
    );
    await pool.query(
      "INSERT INTO content_items(id,org_id,brand_id,body) VALUES ($1,$2,$3,'Legacy reviewed text')",
      [oldContentId, oldOrg, oldBrandId],
    );
    await pool.query(
      "INSERT INTO adaptations(id,org_id,content_item_id,channel_id,status,attempt_count,failure_reason) VALUES ($1,$2,$3,$4,'failed',2,'outcome_unknown')",
      [oldAdaptationId, oldOrg, oldContentId, oldChannelId],
    );
    await pool.query(
      "INSERT INTO publications(id,org_id,adaptation_id,channel_id,status,attempt,external_id) VALUES ($1,$2,$3,$4,'unknown',2,'retained-actual-post')",
      [oldReceiptId, oldOrg, oldAdaptationId, oldChannelId],
    );
    before = await legacyRows();
    await runMigrations(connectionString);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (directory) await fs.rm(directory, { force: true, recursive: true });
    if (!database) return;
    if (!/^pubrick_meta_foundation_[a-f0-9]{32}_test$/.test(database))
      throw new Error("Unowned database");
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  async function legacyRows(): Promise<unknown[]> {
    return [
      (await pool.query("SELECT * FROM channels WHERE id=$1", [oldChannelId])).rows,
      (await pool.query("SELECT * FROM adaptations WHERE id=$1", [oldAdaptationId])).rows,
      (await pool.query("SELECT * FROM publications WHERE id=$1", [oldReceiptId])).rows,
    ];
  }
  async function fixture() {
    const orgId = `meta-stage-${randomUUID()}`;
    const brandId = randomUUID();
    await pool.query("INSERT INTO organization(id,name,slug) VALUES ($1,'Synthetic',$1)", [orgId]);
    await pool.query("INSERT INTO brands(id,org_id,name) VALUES ($1,$2,'Synthetic')", [
      brandId,
      orgId,
    ]);
    const createdAt = new Date();
    // These resource UUIDs are immutable audit identity after resource deletion,
    // not foreign keys that would erase a possibly-public final request.
    return {
      id: randomUUID(),
      org_id: orgId,
      brand_id: brandId,
      adaptation_id: randomUUID(),
      content_item_id: randomUUID(),
      channel_id: randomUUID(),
      platform: "threads",
      attempt: 1,
      input_hash: "b".repeat(64),
      frozen_input: JSON.stringify(input),
      target: "threads:12345",
      credential_generation: 1,
      phase: "preparation_intent",
      created_at: createdAt,
      preparation_deadline: new Date(createdAt.getTime() + 300_000),
    };
  }
  async function insert(row: Record<string, unknown>) {
    return pool.query(
      `INSERT INTO meta_publication_stages (${Object.keys(row).join(",")}) VALUES (${Object.keys(
        row,
      )
        .map((_, i) => `$${i + 1}`)
        .join(",")}) RETURNING *`,
      Object.values(row),
    );
  }

  it("applies 0135 after the real 0134 predecessor without rewriting credentials or receipts", async () => {
    expect(migrationWhen).toBeGreaterThan(predecessorWhen);
    const last = await pool.query(
      "SELECT max(created_at)::text AS created_at FROM drizzle.__drizzle_migrations",
    );
    expect(last.rows[0]?.created_at).toBe(String(migrationWhen));
    expect(await legacyRows()).toEqual(before);
    expect(
      (await pool.query("SELECT to_regclass('public.meta_publication_stages') AS target")).rows[0]
        ?.target,
    ).toBe("meta_publication_stages");
  });
  it("admits exact text and bounded approved image metadata without capabilities or secrets", async () => {
    const row = await fixture();
    const saved = await insert(row);
    expect(saved.rows[0]?.frozen_input).toEqual(input);
    const image = await insert({
      ...row,
      id: randomUUID(),
      adaptation_id: randomUUID(),
      platform: "instagram_native",
      target: "instagram:12345",
      frozen_input: JSON.stringify({ ...input, platform: "instagram_native", image: jpeg }),
    });
    expect(image.rows[0]?.frozen_input).toEqual({
      ...input,
      platform: "instagram_native",
      image: jpeg,
    });
  });
  it.each([
    ["missing_text", { version: 1, platform: "threads" }],
    ["string_version", { ...input, version: "1" }],
    ["extra_url", { ...input, url: "https://media.example.com/?capability=secret" }],
    ["extra_nested_secret", { ...input, ignored: { accessToken: "fixture-secret" } }],
    ["text_attachment", { ...input, image: jpeg }],
    ["too_long", { ...input, text: "x".repeat(4097) }],
  ])("rejects only the malformed approved payload %s", async (_name, frozenInput) => {
    await expect(
      insert({ ...(await fixture()), frozen_input: JSON.stringify(frozenInput) }),
    ).rejects.toMatchObject({ code: "23514", constraint: "meta_publication_stages_input_check" });
  });
  it.each([
    ["missing_image", undefined],
    ["extra_capability", { ...jpeg, url: "https://media.example.com/?capability=secret" }],
    ["wrong_digest", { ...jpeg, sha256: "invalid" }],
    ["string_width", { ...jpeg, width: "1080" }],
    ["oversized_width", { ...jpeg, width: 20001 }],
    ["oversized_bytes", { ...jpeg, byteSize: 10485761 }],
    ["missing_height", { ...jpeg, height: undefined }],
  ])("rejects only the malformed Instagram metadata %s", async (_name, image) => {
    await expect(
      insert({
        ...(await fixture()),
        platform: "instagram_native",
        target: "instagram:12345",
        frozen_input: JSON.stringify({
          ...input,
          platform: "instagram_native",
          ...(image ? { image } : {}),
        }),
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "meta_publication_stages_input_check" });
  });
  it.each([
    ["attempt", { attempt: 0 }, "attempt"],
    ["generation", { credential_generation: -1 }, "attempt"],
    ["polls", { poll_count: 121 }, "attempt"],
    ["digest", { input_hash: "B".repeat(64) }, "input_hash"],
    ["target", { target: "instagram:12345" }, "target"],
    ["lease_pair", { lease_token: randomUUID() }, "lease_pair"],
    ["container", { phase: "waiting", container_id: "../unsafe" }, "container"],
    ["premature_receipt", { container_id: "99887" }, "checkpoint"],
    ["waiting_receipt", { phase: "waiting" }, "checkpoint"],
    [
      "missing_actual_post",
      { phase: "published", container_id: "99887", final_publication_id: randomUUID() },
      "checkpoint",
    ],
    [
      "container_as_post",
      {
        phase: "final_unknown",
        container_id: "99887",
        final_publication_id: randomUUID(),
        external_id: "99887",
      },
      "receipt",
    ],
  ])("rejects the single invalid %s invariant", async (_name, invalid, check) => {
    await expect(insert({ ...(await fixture()), ...invalid })).rejects.toMatchObject({
      code: "23514",
      constraint: `meta_publication_stages_${check}_check`,
    });
  });
  it("admits waiting and final outcomes only with the appropriate actual identities", async () => {
    const row = await fixture();
    for (const state of [
      { phase: "waiting", container_id: "99887" },
      {
        phase: "preparation_unknown",
        container_id: "99887",
        failure_reason: "preparation_receipt_lost",
      },
      { phase: "final_intent", container_id: "99887", final_publication_id: randomUUID() },
      {
        phase: "final_unknown",
        container_id: "99887",
        final_publication_id: randomUUID(),
        external_id: "44556",
      },
      {
        phase: "published",
        container_id: "99887",
        final_publication_id: randomUUID(),
        external_id: "44556",
      },
      {
        phase: "published_without_receipt",
        container_id: "99887",
        failure_reason: "published_without_receipt",
      },
    ])
      await insert({ ...row, id: randomUUID(), adaptation_id: randomUUID(), ...state });
  });
  it.each(["expired", "beyond_maximum"])("refuses a %s preparation deadline", async (kind) => {
    const row = await fixture();
    const preparationDeadline =
      kind === "expired"
        ? row.created_at
        : new Date(row.created_at.getTime() + 24 * 60 * 60 * 1000 + 1);
    await expect(
      insert({ ...row, preparation_deadline: preparationDeadline }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "meta_publication_stages_deadline_check",
    });
  });
  it.each([
    ["phase", { phase: "waitng" }, "phase"],
    ["failure_reason", { failure_reason: "connection_change" }, "failure_reason"],
  ])(
    "refuses a misspelled %s while all other fields remain valid",
    async (_name, invalid, check) => {
      await expect(insert({ ...(await fixture()), ...invalid })).rejects.toMatchObject({
        code: "23514",
        constraint: `meta_publication_stages_${check}_check`,
      });
    },
  );
  it("keeps one checkpoint per tenant adaptation attempt", async () => {
    const row = await fixture();
    await insert(row);
    await expect(insert({ ...row, id: randomUUID() })).rejects.toMatchObject({
      code: "23505",
      constraint: "meta_publication_stages_org_adaptation_attempt_idx",
    });
    await insert({ ...row, id: randomUUID(), attempt: 2 });
  });
  it("keeps immutable final intent audit without live targets and erases it with its brand", async () => {
    const row = await fixture();
    const result = await insert({
      ...row,
      phase: "final_intent",
      container_id: "99887",
      final_publication_id: randomUUID(),
    });
    expect(result.rows[0]?.channel_id).toBe(row.channel_id);
    expect(result.rows[0]?.adaptation_id).toBe(row.adaptation_id);
    expect(
      (
        await pool.query("SELECT count(*)::int AS count FROM meta_publication_stages WHERE id=$1", [
          row.id,
        ])
      ).rows[0]?.count,
    ).toBe(1);
    await pool.query("DELETE FROM brands WHERE id=$1", [row.brand_id]);
    expect(
      (
        await pool.query("SELECT count(*)::int AS count FROM meta_publication_stages WHERE id=$1", [
          row.id,
        ])
      ).rows[0]?.count,
    ).toBe(0);
  });
  it("refuses a checkpoint whose live brand belongs to a different organization", async () => {
    const own = await fixture();
    const stranger = await fixture();
    await expect(insert({ ...own, brand_id: stranger.brand_id })).rejects.toMatchObject({
      code: "23503",
      constraint: "meta_publication_stages_brand_org_fk",
    });
  });
});
