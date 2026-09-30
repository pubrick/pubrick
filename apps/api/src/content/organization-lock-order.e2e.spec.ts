import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EditorialNotesRepository } from "./editorial-notes.repository";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("tenant deletion lock order", () => {
  let database: ReturnType<typeof createDb>;
  let notes: EditorialNotesRepository;
  let apiPool: { end(): Promise<void> };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    database = createDb(url as string);
    const { EditorialNotesRepository } = await import("./editorial-notes.repository");
    notes = new EditorialNotesRepository();
    apiPool = (await import("../db")).pool;
  });
  afterAll(async () => {
    await apiPool?.end();
    await database?.pool.end();
  });

  it("lets tenant deletion cascade while a note waits for the organization", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();
    await database.db.insert(schema.user).values({
      id: userId,
      name: "Lock order reviewer",
      email: `${userId}@example.test`,
    });
    await database.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Lock order", slug: orgId });
    const [brand] = await database.db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning();
    const [item] = await database.db
      .insert(schema.contentItems)
      .values({ orgId, brandId: brand!.id, body: "Draft" })
      .returning();
    const deleter = await database.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await deleter.query("BEGIN");
      const {
        rows: [connection],
      } = await deleter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      // The owner delete takes this parent lock before its cascading child locks.
      await deleter.query("SELECT id FROM organization WHERE id = $1 FOR UPDATE", [orgId]);
      pending = notes
        .create(orgId, item!.id, userId, { note: "Useful note", expectedBody: "Draft" })
        .catch((error: unknown) => error);
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { rows } = await database.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting",
          [connection!.pid],
        );
        if (rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      // Before the fix, create holds content_items and waits for this org FK:
      // DELETE waits for that item and PostgreSQL aborts either writer (40P01).
      await deleter.query("DELETE FROM organization WHERE id = $1", [orgId]);
      await deleter.query("COMMIT");
      const result = await pending;
      expect(result).toMatchObject({ status: 404 });
    } finally {
      await deleter.query("ROLLBACK");
      deleter.release();
      await pending;
      await database.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await database.db.delete(schema.user).where(eq(schema.user.id, userId));
    }
  });
});
