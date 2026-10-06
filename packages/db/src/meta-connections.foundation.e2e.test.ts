import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

const baseUrl = process.env.TEST_DATABASE_URL;
const migrationTag = "0136_native_meta_connections";

describe.skipIf(!baseUrl)(
  "native Meta connection foundation and populated PostgreSQL upgrade",
  () => {
    let pool: pg.Pool;
    let database: string | undefined;
    let directory: string | undefined;
    let predecessorWhen: number;
    let migrationWhen: number;
    let latestWhen: number;
    let oldOrgId: string;
    let oldBrandId: string;
    let oldManualId: string;
    let oldNativeId: string;
    let before: unknown[];

    beforeAll(async () => {
      if (!baseUrl) throw new Error("Missing disposable database URL");
      const parsed = new URL(baseUrl);
      if (
        !["postgres:", "postgresql:"].includes(parsed.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
        !/^\/pubrick_.*_test$/.test(parsed.pathname)
      )
        throw new Error(
          "Meta connection foundation requires loopback disposable pubrick_*_test database",
        );
      const name = `pubrick_meta_connections_${randomUUID().replaceAll("-", "")}_test`;
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
      const predecessor = journal.entries[cut - 1];
      const current = journal.entries[cut];
      const latest = journal.entries.at(-1);
      if (cut < 1 || !predecessor || !current || !latest)
        throw new Error("Meta connection migration chain is incomplete");
      expect(predecessor.tag).toBe("0135_meta_publication_stages");
      predecessorWhen = predecessor.when;
      migrationWhen = current.when;
      latestWhen = latest.when;
      directory = await fs.mkdtemp(path.join(tmpdir(), "pubrick-meta-connections-migration-"));
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
      expect(
        (
          await pool.query(
            "SELECT max(created_at)::text AS created_at FROM drizzle.__drizzle_migrations",
          )
        ).rows[0]?.created_at,
      ).toBe(String(predecessorWhen));
      expect(
        (await pool.query("SELECT to_regclass('public.meta_authorization_requests') AS target"))
          .rows[0]?.target,
      ).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='channels' AND column_name='connection_application_id'",
          )
        ).rows[0]?.n,
      ).toBe(0);

      oldOrgId = `meta-old-${randomUUID()}`;
      oldBrandId = randomUUID();
      oldManualId = randomUUID();
      oldNativeId = randomUUID();
      const itemId = randomUUID();
      const queuedId = randomUUID();
      const publishedId = randomUUID();
      await pool.query("INSERT INTO organization(id,name,slug) VALUES ($1,'Legacy',$1)", [
        oldOrgId,
      ]);
      await pool.query("INSERT INTO brands(id,org_id,name) VALUES ($1,$2,'Legacy')", [
        oldBrandId,
        oldOrgId,
      ]);
      await pool.query(
        "INSERT INTO channels(id,org_id,brand_id,platform,name,credentials_encrypted) VALUES ($1,$2,$3,'instagram','Legacy manual Instagram',NULL),($4,$2,$3,'telegram','Legacy native Telegram','retained-opaque-cipher')",
        [oldManualId, oldOrgId, oldBrandId, oldNativeId],
      );
      await pool.query(
        "INSERT INTO content_items(id,org_id,brand_id,title,body,status) VALUES ($1,$2,$3,'Saved review','Legacy reviewed text','partially_published')",
        [itemId, oldOrgId, oldBrandId],
      );
      await pool.query(
        "INSERT INTO adaptations(id,org_id,content_item_id,channel_id,status,attempt_count) VALUES ($1,$2,$3,$4,'queued',3),($5,$2,$3,$4,'published',2),($6,$2,$3,$7,'manual_ready',0)",
        [queuedId, oldOrgId, itemId, oldNativeId, publishedId, randomUUID(), oldManualId],
      );
      await pool.query(
        "INSERT INTO publications(id,org_id,adaptation_id,channel_id,status,attempt,external_id,external_url) VALUES ($1,$2,$3,$4,'published',2,'123456','https://t.me/retained/123456')",
        [randomUUID(), oldOrgId, publishedId, oldNativeId],
      );
      await pool.query(
        "INSERT INTO editorial_placeholders(id,org_id,brand_id,date,platform,notes) VALUES ($1,$2,$3,'2026-10-08','instagram','Keep manual workflow')",
        [randomUUID(), oldOrgId, oldBrandId],
      );
      before = await legacyRows();
      await runMigrations(connectionString);
      expect(
        (await pool.query("SELECT count(*)::int AS n FROM meta_authorization_requests")).rows[0]?.n,
      ).toBe(0);
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
      if (directory) await fs.rm(directory, { force: true, recursive: true });
      if (!database) return;
      if (!/^pubrick_meta_connections_[a-f0-9]{32}_test$/.test(database))
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
        // The only new predecessor field is nullable application lineage. Compare
        // every prior column, not a hand-picked subset of preserved credentials.
        (
          await pool.query(
            "SELECT to_jsonb(c)-'connection_application_id' AS row FROM channels c WHERE org_id=$1 ORDER BY id",
            [oldOrgId],
          )
        ).rows,
        (await pool.query("SELECT * FROM content_items WHERE org_id=$1 ORDER BY id", [oldOrgId]))
          .rows,
        (await pool.query("SELECT * FROM adaptations WHERE org_id=$1 ORDER BY id", [oldOrgId]))
          .rows,
        (await pool.query("SELECT * FROM publications WHERE org_id=$1 ORDER BY id", [oldOrgId]))
          .rows,
        (
          await pool.query("SELECT * FROM editorial_placeholders WHERE org_id=$1 ORDER BY id", [
            oldOrgId,
          ])
        ).rows,
      ];
    }
    async function scope() {
      const orgId = `meta-scope-${randomUUID()}`;
      const brandId = randomUUID();
      await pool.query("INSERT INTO organization(id,name,slug) VALUES ($1,'Synthetic',$1)", [
        orgId,
      ]);
      await pool.query("INSERT INTO brands(id,org_id,name) VALUES ($1,$2,'Synthetic')", [
        brandId,
        orgId,
      ]);
      return { orgId, brandId };
    }
    async function stateFixture(provider = "threads") {
      const { orgId, brandId } = await scope();
      const createdAt = new Date();
      return {
        id: randomUUID(),
        org_id: orgId,
        brand_id: brandId,
        provider,
        application_id: "123456",
        redirect_uri: `https://pubrick.example.com/en/connections/meta/${provider}`,
        user_id: `actor-${randomUUID()}`,
        session_id: `session-${randomUUID()}`,
        state_hash: createHash("sha256").update(randomUUID()).digest("hex"),
        channel_id: null,
        expected_generation: null,
        expected_target: null,
        name: "Synthetic connection",
        locale: "en",
        created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 600_000),
      };
    }
    async function insert(
      table: "channels" | "meta_authorization_requests",
      row: Record<string, unknown>,
    ) {
      const columns = Object.keys(row);
      return pool.query(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`,
        Object.values(row),
      );
    }
    async function channelFixture(platform = "threads", target = "threads:654321") {
      const { orgId, brandId } = await scope();
      return {
        id: randomUUID(),
        org_id: orgId,
        brand_id: brandId,
        platform,
        name: "Synthetic native",
        credentials_encrypted: "synthetic-opaque-cipher",
        connection_application_id: "123456",
        connection_target: target,
        connection_generation: 1,
      };
    }

    it("applies 0136 after real 0135 without converting manual Instagram or rewriting queued adaptations and history", async () => {
      expect(migrationWhen).toBeGreaterThan(predecessorWhen);
      expect(
        (
          await pool.query(
            "SELECT max(created_at)::text AS created_at FROM drizzle.__drizzle_migrations",
          )
        ).rows[0]?.created_at,
      ).toBe(String(latestWhen));
      expect(await legacyRows()).toEqual(before);
      const legacy = await pool.query(
        "SELECT id,platform,credentials_encrypted,connection_application_id FROM channels WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[oldManualId, oldNativeId]],
      );
      expect(legacy.rows.find((row) => row.id === oldManualId)).toMatchObject({
        platform: "instagram",
        credentials_encrypted: null,
        connection_application_id: null,
      });
      expect(legacy.rows.find((row) => row.id === oldNativeId)).toMatchObject({
        platform: "telegram",
        credentials_encrypted: "retained-opaque-cipher",
        connection_application_id: null,
      });
    });

    it.each([
      ["threads", "threads:654321"],
      ["instagram_native", "instagram:654321"],
      ["facebook_page", "facebook-page:654321"],
    ])(
      "allows a real %s native disconnect while retaining target and application identity",
      async (platform, target) => {
        const values = await channelFixture(platform, target);
        await insert("channels", values);
        const disconnected = await pool.query(
          "UPDATE channels SET credentials_encrypted=NULL,connection_generation=connection_generation+1,connection_disconnected_at=clock_timestamp() WHERE id=$1 RETURNING credentials_encrypted,connection_generation,connection_target,connection_application_id",
          [values.id],
        );
        expect(disconnected.rows[0]).toEqual({
          credentials_encrypted: null,
          connection_generation: 2,
          connection_target: target,
          connection_application_id: "123456",
        });
      },
    );

    it.each([
      ["missing application", { connection_application_id: null }, "channels_meta_target_check"],
      [
        "invalid application",
        { connection_application_id: "0" },
        "channels_connection_application_check",
      ],
      ["missing target", { connection_target: null }, "channels_meta_target_check"],
      [
        "wrong provider target",
        { connection_target: "instagram:654321" },
        "channels_meta_target_check",
      ],
      ["unknown platform", { platform: "unsupported" }, "channels_platform_check"],
    ])("rejects only native channel %s", async (_name, patch, constraint) => {
      await expect(
        insert("channels", { ...(await channelFixture()), ...patch }),
      ).rejects.toMatchObject({ code: "23514", constraint });
    });

    it("retains the old manual/native credential-mode checks", async () => {
      await expect(
        pool.query("UPDATE channels SET credentials_encrypted='must-not-be-accepted' WHERE id=$1", [
          oldManualId,
        ]),
      ).rejects.toMatchObject({ code: "23514", constraint: "channels_credentials_mode_check" });
      await expect(
        pool.query("UPDATE channels SET credentials_encrypted=NULL WHERE id=$1", [oldNativeId]),
      ).rejects.toMatchObject({ code: "23514", constraint: "channels_credentials_mode_check" });
      expect(await legacyRows()).toEqual(before);
    });

    it("admits new initial state with NULL optional evidence and a complete scoped reconnect intent", async () => {
      const initial = await stateFixture();
      const created = await insert("meta_authorization_requests", initial);
      expect(created.rows[0]).toMatchObject({
        consumed_at: null,
        page_selection_encrypted: null,
        page_selection_consumed_at: null,
        channel_id: null,
        expected_generation: null,
        expected_target: null,
      });
      const channel = await channelFixture();
      await insert("channels", channel);
      const reconnect = await insert("meta_authorization_requests", {
        ...initial,
        id: randomUUID(),
        org_id: channel.org_id,
        brand_id: channel.brand_id,
        state_hash: createHash("sha256").update(randomUUID()).digest("hex"),
        channel_id: channel.id,
        expected_generation: 1,
        expected_target: channel.connection_target,
      });
      expect(reconnect.rows[0]).toMatchObject({
        channel_id: channel.id,
        expected_generation: 1,
        expected_target: channel.connection_target,
      });
    });

    it.each([
      ["provider", { provider: "linkedin" }, "requests_provider"],
      ["application", { application_id: "0" }, "application"],
      ["callback", { redirect_uri: "http://pubrick.example.com/callback" }, "callback"],
      ["locale", { locale: "de" }, "requests_locale"],
      ["hash", { state_hash: "A".repeat(64) }, "hash"],
      ["empty user", { user_id: "" }, "actor"],
      ["empty session", { session_id: "" }, "actor"],
      ["long actor", { user_id: "x".repeat(201) }, "actor"],
      ["empty name", { name: "" }, "name"],
      ["partial reconnect", { expected_generation: 0 }, "intent"],
      [
        "unconsumed selection",
        { provider: "facebook_page", page_selection_encrypted: "synthetic-cipher" },
        "page_selection",
      ],
      [
        "wrong provider selection",
        { consumed_at: new Date(), page_selection_encrypted: "synthetic-cipher" },
        "page_selection",
      ],
      [
        "unconsumed settled selection",
        { provider: "facebook_page", page_selection_consumed_at: new Date() },
        "page_selection",
      ],
      [
        "retained consumed selection cipher",
        {
          provider: "facebook_page",
          consumed_at: new Date(),
          page_selection_consumed_at: new Date(),
          page_selection_encrypted: "synthetic-cipher",
        },
        "page_selection",
      ],
    ])("rejects only malformed state %s", async (_name, patch, constraint) => {
      await expect(
        insert("meta_authorization_requests", { ...(await stateFixture()), ...patch }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: `meta_authorization_${constraint}_check`,
      });
    });

    it.each([0, -1, 600_001])("refuses state lifetime %s milliseconds", async (duration) => {
      const values = await stateFixture();
      await expect(
        insert("meta_authorization_requests", {
          ...values,
          expires_at: new Date(values.created_at.getTime() + duration),
        }),
      ).rejects.toMatchObject({ code: "23514", constraint: "meta_authorization_expiry_check" });
    });

    it("retains encrypted Page choices only between original consumption and explicit selection", async () => {
      const values = await stateFixture("facebook_page");
      await insert("meta_authorization_requests", {
        ...values,
        consumed_at: new Date(),
        page_selection_encrypted: "synthetic-encrypted-page-choices",
      });
      const consumed = await pool.query(
        "UPDATE meta_authorization_requests SET page_selection_encrypted=NULL,page_selection_consumed_at=clock_timestamp() WHERE id=$1 RETURNING page_selection_encrypted,page_selection_consumed_at",
        [values.id],
      );
      expect(consumed.rows[0]?.page_selection_encrypted).toBeNull();
      expect(consumed.rows[0]?.page_selection_consumed_at).toBeInstanceOf(Date);
    });

    it("rejects repeated state hashes before any second retained request", async () => {
      const first = await stateFixture();
      await insert("meta_authorization_requests", first);
      await expect(
        insert("meta_authorization_requests", {
          ...(await stateFixture()),
          state_hash: first.state_hash,
        }),
      ).rejects.toMatchObject({ code: "23505", constraint: "meta_authorization_state_hash_idx" });
    });

    it("rejects cross-organization brand and reconnect channel identities with exact parent FKs", async () => {
      const state = await stateFixture();
      const foreign = await scope();
      await expect(
        insert("meta_authorization_requests", { ...state, brand_id: foreign.brandId }),
      ).rejects.toMatchObject({ code: "23503", constraint: "meta_authorization_brand_org_fk" });
      const channel = await channelFixture();
      await insert("channels", channel);
      await expect(
        insert("meta_authorization_requests", {
          ...state,
          channel_id: channel.id,
          expected_generation: 1,
          expected_target: channel.connection_target,
        }),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "meta_authorization_channel_brand_org_fk",
      });
      const otherBrand = randomUUID();
      await pool.query("INSERT INTO brands(id,org_id,name) VALUES ($1,$2,'Other brand')", [
        otherBrand,
        channel.org_id,
      ]);
      await expect(
        insert("meta_authorization_requests", {
          ...state,
          org_id: channel.org_id,
          brand_id: otherBrand,
          channel_id: channel.id,
          expected_generation: 1,
          expected_target: channel.connection_target,
        }),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "meta_authorization_channel_brand_org_fk",
      });
    });

    it("erases transient reconnect state with its exact channel and initial state with its tenant", async () => {
      const channel = await channelFixture();
      await insert("channels", channel);
      const state = await stateFixture();
      await insert("meta_authorization_requests", {
        ...state,
        org_id: channel.org_id,
        brand_id: channel.brand_id,
        channel_id: channel.id,
        expected_generation: 1,
        expected_target: channel.connection_target,
      });
      await pool.query("DELETE FROM channels WHERE id=$1", [channel.id]);
      expect(
        (await pool.query("SELECT id FROM meta_authorization_requests WHERE id=$1", [state.id]))
          .rows,
      ).toEqual([]);
      const initial = await stateFixture();
      await insert("meta_authorization_requests", initial);
      await pool.query("DELETE FROM organization WHERE id=$1", [initial.org_id]);
      expect(
        (await pool.query("SELECT id FROM meta_authorization_requests WHERE id=$1", [initial.id]))
          .rows,
      ).toEqual([]);
    });

    it.each(["threads", "instagram_native", "facebook_page"])(
      "admits %s editorial placeholders while preserving the existing manual one",
      async (platform) => {
        const { orgId, brandId } = await scope();
        await pool.query(
          "INSERT INTO editorial_placeholders(id,org_id,brand_id,date,platform) VALUES ($1,$2,$3,'2026-10-09',$4)",
          [randomUUID(), orgId, brandId, platform],
        );
        expect(
          (
            await pool.query(
              "SELECT notes FROM editorial_placeholders WHERE org_id=$1 AND platform='instagram'",
              [oldOrgId],
            )
          ).rows,
        ).toEqual([{ notes: "Keep manual workflow" }]);
      },
    );
  },
);
