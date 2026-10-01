import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BillingTransaction } from "./billing-entitlement.js";
import { createDb } from "./client.js";
import { hashEditorialSnapshot, readEditorialSnapshot } from "./editorial-snapshot.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";
import { lockFreshTelegramDraft } from "./telegram-fresh-draft.js";

const baseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!baseUrl)("locked fresh Telegram draft on native PostgreSQL", () => {
  let db: ReturnType<typeof createDb>["db"];
  let pool: pg.Pool;
  let database: string | undefined;
  beforeAll(async () => {
    if (!baseUrl) throw new Error("Missing disposable database URL");
    const parsed = new URL(baseUrl);
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      !/^\/pubrick_.*_test$/.test(parsed.pathname)
    )
      throw new Error("Fresh-draft tests require a loopback disposable pubrick_*_test database");
    const name = `pubrick_telegram_fresh_${randomUUID().replaceAll("-", "")}_test`;
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      database = name;
    } finally {
      await admin.end();
    }
    parsed.pathname = `/${name}`;
    await runMigrations(parsed.toString());
    ({ db, pool } = createDb(parsed.toString(), { max: 4 }));
  }, 60_000);
  afterAll(async () => {
    await pool?.end();
    if (!database) return;
    if (!/^pubrick_telegram_fresh_[a-f0-9]{32}_test$/.test(database))
      throw new Error("Unowned database");
    const admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  async function fixture() {
    const orgId = `fresh-${randomUUID()}`;
    await db.insert(schema.organization).values({ id: orgId, name: "Synthetic", slug: orgId });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Synthetic" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing brand");
    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId: brand.id, title: "Synthetic draft", body: "Master body." })
      .returning({ id: schema.contentItems.id });
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "Synthetic Telegram",
        platform: "telegram",
        credentialsEncrypted: "synthetic-unused",
      })
      .returning({ id: schema.channels.id });
    if (!item || !channel) throw new Error("Missing draft/channel");
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({ orgId, contentItemId: item.id, channelId: channel.id })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("Missing adaptation");
    return {
      orgId,
      brandId: brand.id,
      itemId: item.id,
      channelId: channel.id,
      adaptationId: adaptation.id,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function parents(tx: BillingTransaction, f: Fixture) {
    await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, f.orgId))
      .for("key share");
    await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, f.orgId), eq(schema.brands.id, f.brandId)))
      .for("share");
  }
  const check = (f: Fixture, queue = false) =>
    db.transaction(async (tx) => {
      await parents(tx, f);
      return lockFreshTelegramDraft(tx, f.orgId, f.brandId, f.itemId, async () => queue);
    });
  it("returns the existing full snapshot/hash and passes sorted IDs in the owning transaction", async () => {
    const f = await fixture();
    const [second] = await db
      .insert(schema.channels)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        name: "Second",
        platform: "telegram",
        credentialsEncrypted: "unused",
      })
      .returning({ id: schema.channels.id });
    if (!second) throw new Error("Missing channel");
    await db.insert(schema.adaptations).values({
      orgId: f.orgId,
      contentItemId: f.itemId,
      channelId: second.id,
      body: "Effective override.",
    });
    const queue = vi.fn(
      async (_tx: BillingTransaction, _orgId: string, _ids: readonly string[]) => false,
    );
    const result = await db.transaction(async (tx) => {
      await parents(tx, f);
      const value = await lockFreshTelegramDraft(tx, f.orgId, f.brandId, f.itemId, queue);
      expect(queue.mock.calls[0]?.[0]).toBe(tx);
      return value;
    });
    const snapshot = await readEditorialSnapshot(db, f.orgId, f.itemId);
    expect(result).toEqual({ snapshot, hash: snapshot && hashEditorialSnapshot(snapshot) });
    expect(result?.snapshot.channels.map((row) => row.body)).toContain("Master body.");
    expect(result?.snapshot.channels.map((row) => row.body)).toContain("Effective override.");
    const ids = (
      await db
        .select({ id: schema.adaptations.id })
        .from(schema.adaptations)
        .where(eq(schema.adaptations.contentItemId, f.itemId))
        .orderBy(asc(schema.adaptations.id))
    ).map((row) => row.id);
    expect(queue.mock.calls[0]?.slice(1)).toEqual([f.orgId, ids]);
  });
  it("refuses every nonfresh state, scheduling/attempts, durable historical marker and queued work", async () => {
    for (const status of [
      "approved",
      "rejected",
      "failed",
      "archived",
      "partially_published",
      "published",
    ] as const) {
      const f = await fixture();
      await db
        .update(schema.contentItems)
        .set(status === "archived" ? { status, archivedFromStatus: "draft" } : { status })
        .where(eq(schema.contentItems.id, f.itemId));
      expect(await check(f), status).toBeNull();
    }
    for (const fields of [
      { status: "failed" as const },
      { scheduledAt: new Date() },
      { attemptCount: 1 },
    ]) {
      const f = await fixture();
      await db
        .update(schema.adaptations)
        .set(fields)
        .where(eq(schema.adaptations.id, f.adaptationId));
      expect(await check(f)).toBeNull();
    }
    const historical = await fixture();
    await db
      .update(schema.contentItems)
      .set({ isSafeToDelete: false })
      .where(eq(schema.contentItems.id, historical.itemId));
    expect(await check(historical)).toBeNull();
    expect(await check(await fixture(), true)).toBeNull();
    const empty = await fixture();
    await db.delete(schema.adaptations).where(eq(schema.adaptations.id, empty.adaptationId));
    expect(await check(empty)).toBeNull();
  });
  it("refuses all publication history and manual handoffs, including history lost through channel removal", async () => {
    for (const status of ["in_flight", "unknown", "failed", "published"] as const) {
      const f = await fixture();
      await db
        .insert(schema.publications)
        .values({ orgId: f.orgId, adaptationId: f.adaptationId, channelId: f.channelId, status });
      expect(await check(f), status).toBeNull();
    }
    const f = await fixture();
    const [feed] = await db
      .insert(schema.brandFeeds)
      .values({ orgId: f.orgId, brandId: f.brandId, publicToken: randomUUID() })
      .returning({ id: schema.brandFeeds.id });
    if (!feed) throw new Error("Missing feed");
    await db.insert(schema.feedEntries).values({
      orgId: f.orgId,
      brandId: f.brandId,
      feedId: feed.id,
      contentItemId: f.itemId,
      title: "Historical handoff",
      body: "Synthetic",
    });
    expect(await check(f)).toBeNull();
    const removed = await fixture();
    await db.insert(schema.publications).values({
      orgId: removed.orgId,
      adaptationId: removed.adaptationId,
      channelId: removed.channelId,
      status: "failed",
    });
    await db.delete(schema.channels).where(eq(schema.channels.id, removed.channelId));
    const [replacement] = await db
      .insert(schema.channels)
      .values({
        orgId: removed.orgId,
        brandId: removed.brandId,
        name: "Replacement",
        platform: "telegram",
        credentialsEncrypted: "unused",
      })
      .returning({ id: schema.channels.id });
    if (!replacement) throw new Error("Missing replacement");
    await db
      .insert(schema.adaptations)
      .values({ orgId: removed.orgId, contentItemId: removed.itemId, channelId: replacement.id });
    expect(await check(removed)).toBeNull();
  });
  it("refuses cross-org item-linked adaptations and wrong-brand channels", async () => {
    const f = await fixture();
    const foreign = await fixture();
    expect(await check({ ...f, brandId: foreign.brandId })).toBeNull();
    await db
      .insert(schema.adaptations)
      .values({ orgId: foreign.orgId, contentItemId: f.itemId, channelId: foreign.channelId });
    expect(await check(f)).toBeNull();
    const g = await fixture();
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId: g.orgId, name: "Other brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing other brand");
    await db
      .update(schema.channels)
      .set({ brandId: brand.id })
      .where(eq(schema.channels.id, g.channelId));
    expect(await check(g)).toBeNull();
  });
  async function overlappingChannelMutation(kind: "rename" | "delete") {
    const f = await fixture();
    let entered!: (value: { pid: number; hash: string }) => void;
    let release!: () => void;
    const ready = new Promise<{ pid: number; hash: string }>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = db.transaction(async (tx) => {
      await parents(tx, f);
      const result = await lockFreshTelegramDraft(
        tx,
        f.orgId,
        f.brandId,
        f.itemId,
        async () => false,
      );
      expect(result).not.toBeNull();
      const pid = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      entered({ pid: Number(pid.rows[0]?.pid), hash: result?.hash ?? "" });
      await held;
      const again = await readEditorialSnapshot(tx, f.orgId, f.itemId);
      expect(again && hashEditorialSnapshot(again)).toBe(result?.hash);
      return result;
    });
    const current = await ready;
    const writer = await pool.connect();
    let mutation: Promise<{ error?: unknown }> | undefined;
    try {
      const pid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      mutation = writer
        .query(
          kind === "rename"
            ? "UPDATE channels SET name = 'Renamed' WHERE id = $1"
            : "DELETE FROM channels WHERE id = $1",
          [f.channelId],
        )
        .then(
          () => ({}),
          (error: unknown) => ({ error }),
        );
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await pool.query(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [current.pid, pid],
        );
        if (result.rows[0].blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked, "channel mutation must wait on the snapshot owner").toBe(true);
    } finally {
      release();
      await owner;
      expect(await mutation).toEqual({});
      writer.release();
    }
    const after = await check(f);
    if (kind === "delete") expect(after).toBeNull();
    else {
      expect(after?.snapshot.channels[0]?.name).toBe("Renamed");
      expect(after?.hash).not.toBe(current.hash);
    }
  }
  it("holds channel display fields through snapshot commit against real non-key updates", () =>
    overlappingChannelMutation("rename"));
  it("holds channel/adaptation membership through snapshot commit against deletion", () =>
    overlappingChannelMutation("delete"));
});
