import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("posting schedule database bounds", () => {
  let connection: ReturnType<typeof createDb>;
  const orgId = `posting-schema-${randomUUID()}`;
  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string);
  });
  afterAll(async () => {
    if (!connection) return;
    await connection.pool.query("delete from organization where id = $1", [orgId]);
    await connection.pool.end();
  });
  it("keeps existing channels unconfigured and rejects invalid direct SQL bounds", async () => {
    const pool = connection.pool;
    await pool.query("insert into organization (id,name,slug) values ($1,'Posting',$1)", [orgId]);
    const brand = await pool.query<{ id: string }>(
      "insert into brands (org_id,name) values ($1,'Posting') returning id",
      [orgId],
    );
    const channel = await pool.query<{
      id: string;
      posting_timezone: string | null;
      posting_slots: unknown;
      posting_revision: number;
    }>(
      "insert into channels (org_id,brand_id,platform,name,credentials_encrypted) values ($1,$2,'telegram','Posting','opaque-fixture') returning id,posting_timezone,posting_slots,posting_revision",
      [orgId, brand.rows[0]?.id],
    );
    const row = channel.rows[0];
    if (!row) throw new Error("Missing fixture channel");
    expect(row).toMatchObject({ posting_timezone: null, posting_slots: [], posting_revision: 0 });
    await expect(
      pool.query("update channels set posting_revision=-1 where org_id=$1 and id=$2", [
        orgId,
        row.id,
      ]),
    ).rejects.toThrow("channels_posting_revision_check");
    for (const slots of [{}, [{ weekday: 1, localTime: "09:00" }]]) {
      await expect(
        pool.query("update channels set posting_slots=$3::jsonb where org_id=$1 and id=$2", [
          orgId,
          row.id,
          JSON.stringify(slots),
        ]),
      ).rejects.toThrow("channels_posting_slots_check");
    }
    await expect(
      pool.query(
        "update channels set posting_timezone='UTC',posting_slots=$3::jsonb where org_id=$1 and id=$2",
        [
          orgId,
          row.id,
          JSON.stringify(Array.from({ length: 71 }, () => ({ weekday: 1, localTime: "09:00" }))),
        ],
      ),
    ).rejects.toThrow("channels_posting_slots_check");
    await pool.query(
      "update channels set posting_timezone='UTC',posting_slots=$3::jsonb,posting_revision=1 where org_id=$1 and id=$2",
      [orgId, row.id, JSON.stringify([{ weekday: 1, localTime: "09:00" }])],
    );
  });
});
