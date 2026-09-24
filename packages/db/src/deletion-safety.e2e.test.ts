import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("durable content deletion marker", () => {
  let pool: pg.Pool;
  const orgId = `delete-marker-${randomUUID()}`;

  beforeAll(async () => {
    await runMigrations(url as string);
    pool = new pg.Pool({ connectionString: url });
    await pool.query("INSERT INTO organization (id, name, slug) VALUES ($1, 'Delete marker', $1)", [
      orgId,
    ]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM organization WHERE id = $1", [orgId]);
    await pool.end();
  });

  async function seed() {
    const brand = await pool.query<{ id: string }>(
      "INSERT INTO brands (org_id, name) VALUES ($1, 'Brand') RETURNING id",
      [orgId],
    );
    const brandId = brand.rows[0]?.id;
    expect(brandId).toBeDefined();
    const channel = await pool.query<{ id: string }>(
      "INSERT INTO channels (org_id, brand_id, platform, name) VALUES ($1, $2, 'vc_ru', 'Manual') RETURNING id",
      [orgId, brandId],
    );
    const channelId = channel.rows[0]?.id;
    expect(channelId).toBeDefined();
    const item = await pool.query<{ id: string; is_safe_to_delete: boolean }>(
      "INSERT INTO content_items (org_id, brand_id, body) VALUES ($1, $2, 'Draft') RETURNING id, is_safe_to_delete",
      [orgId, brandId],
    );
    const itemId = item.rows[0]?.id;
    expect(itemId).toBeDefined();
    const adaptation = await pool.query<{ id: string }>(
      "INSERT INTO adaptations (org_id, content_item_id, channel_id) VALUES ($1, $2, $3) RETURNING id",
      [orgId, itemId, channelId],
    );
    const adaptationId = adaptation.rows[0]?.id;
    expect(adaptationId).toBeDefined();
    return { itemId, channelId, adaptationId, initiallySafe: item.rows[0]?.is_safe_to_delete };
  }

  it("retains attempted delivery history after channel deletion even without a receipt", async () => {
    const { itemId, channelId, adaptationId, initiallySafe } = await seed();
    expect(initiallySafe).toBe(true);
    await pool.query("UPDATE adaptations SET attempt_count = 1, status = 'failed' WHERE id = $1", [
      adaptationId,
    ]);
    await pool.query("DELETE FROM channels WHERE id = $1", [channelId]);

    const rows = await pool.query<{ is_safe_to_delete: boolean }>(
      "SELECT is_safe_to_delete FROM content_items WHERE id = $1",
      [itemId],
    );
    expect(rows.rows[0]?.is_safe_to_delete).toBe(false);
    expect(
      (await pool.query("SELECT id FROM adaptations WHERE id = $1", [adaptationId])).rows,
    ).toEqual([]);
    // A direct parent cascade must also remain valid after the marker flipped.
    await expect(
      pool.query("DELETE FROM content_items WHERE id = $1", [itemId]),
    ).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it("does not obstruct a direct parent cascade while an attempted adaptation exists", async () => {
    const { itemId, adaptationId } = await seed();
    await pool.query("UPDATE adaptations SET attempt_count = 1 WHERE id = $1", [adaptationId]);
    await expect(
      pool.query("DELETE FROM content_items WHERE id = $1", [itemId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("retains a receipt with zero attempts, but leaves an unsent channel deletion eligible", async () => {
    const withReceipt = await seed();
    await pool.query(
      "INSERT INTO publications (org_id, adaptation_id, channel_id, status) VALUES ($1, $2, $3, 'failed')",
      [orgId, withReceipt.adaptationId, withReceipt.channelId],
    );
    await pool.query("DELETE FROM channels WHERE id = $1", [withReceipt.channelId]);
    const receiptItem = await pool.query<{ is_safe_to_delete: boolean }>(
      "SELECT is_safe_to_delete FROM content_items WHERE id = $1",
      [withReceipt.itemId],
    );
    expect(receiptItem.rows[0]?.is_safe_to_delete).toBe(false);
    await expect(
      pool.query("UPDATE content_items SET is_safe_to_delete = true WHERE id = $1", [
        withReceipt.itemId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE content_items SET title = 'Still editable' WHERE id = $1", [
        withReceipt.itemId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });

    const unsent = await seed();
    await pool.query("DELETE FROM channels WHERE id = $1", [unsent.channelId]);
    const unsentItem = await pool.query<{ is_safe_to_delete: boolean }>(
      "SELECT is_safe_to_delete FROM content_items WHERE id = $1",
      [unsent.itemId],
    );
    expect(unsentItem.rows[0]?.is_safe_to_delete).toBe(true);
  });
});
