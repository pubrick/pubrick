import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { schema } from "./index.js";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("publication webhook outbox", () => {
  let connection: ReturnType<typeof createDb>;
  let orgId: string;
  let otherOrgId: string;
  let subscriptionId: string;

  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string);
    orgId = `webhook-${randomUUID()}`;
    otherOrgId = `webhook-${randomUUID()}`;
    await connection.db.insert(schema.organization).values([
      { id: orgId, name: "Webhooks", slug: orgId },
      { id: otherOrgId, name: "Other", slug: otherOrgId },
    ]);
    const [subscription] = await connection.db
      .insert(schema.webhookSubscriptions)
      .values({
        orgId,
        name: "Test",
        endpointEncrypted: "encrypted-url",
        secretEncrypted: "encrypted-secret",
      })
      .returning({ id: schema.webhookSubscriptions.id });
    assert(subscription);
    subscriptionId = subscription.id;
    await connection.db.insert(schema.webhookSubscriptions).values({
      orgId: otherOrgId,
      name: "Other",
      endpointEncrypted: "other-encrypted-url",
      secretEncrypted: "other-encrypted-secret",
    });
  });

  afterAll(async () => {
    if (connection) {
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
      await connection.pool.end();
    }
  });

  it("queues the terminal transition once in the publication transaction without private text", async () => {
    const [publication] = await connection.db
      .insert(schema.publications)
      .values({ orgId, status: "in_flight", attempt: 2 })
      .returning({ id: schema.publications.id });
    assert(publication);
    const before = await connection.db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.publicationId, publication.id));
    expect(before).toHaveLength(0);

    await connection.db
      .update(schema.publications)
      .set({ status: "published" })
      .where(and(eq(schema.publications.orgId, orgId), eq(schema.publications.id, publication.id)));
    await connection.db
      .update(schema.publications)
      .set({ status: "published" })
      .where(and(eq(schema.publications.orgId, orgId), eq(schema.publications.id, publication.id)));

    const rows = await connection.db
      .select({
        orgId: schema.webhookDeliveries.orgId,
        subscriptionId: schema.webhookDeliveries.subscriptionId,
        event: schema.webhookDeliveries.event,
        payload: schema.webhookDeliveries.payload,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.publicationId, publication.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId,
      subscriptionId,
      event: "publication.succeeded",
      payload: { publicationId: publication.id, status: "published", attempt: 2 },
    });
    expect(JSON.stringify(rows)).not.toContain("encrypted-secret");
    expect(JSON.stringify(rows)).not.toContain("encrypted-url");
  });

  it("rolls the event back with a failed publication transaction", async () => {
    const id = randomUUID();
    await expect(
      connection.db.transaction(async (tx) => {
        await tx.insert(schema.publications).values({ id, orgId, status: "failed" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const rows = await connection.db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.publicationId, id));
    expect(rows).toHaveLength(0);
  });

  it("emits failure and unknown separately, and stops after revocation", async () => {
    const [failed] = await connection.db
      .insert(schema.publications)
      .values({ orgId, status: "failed" })
      .returning({ id: schema.publications.id });
    assert(failed);
    const [unknown] = await connection.db
      .insert(schema.publications)
      .values({ orgId, status: "unknown" })
      .returning({ id: schema.publications.id });
    assert(unknown);
    const events = await connection.db
      .select({ event: schema.webhookDeliveries.event })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.orgId, orgId));
    expect(events.map((row) => row.event).sort()).toEqual([
      "publication.failed",
      "publication.succeeded",
      "publication.unknown",
    ]);
    await connection.db
      .update(schema.webhookSubscriptions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.webhookSubscriptions.id, subscriptionId));
    await connection.db.insert(schema.publications).values({ orgId, status: "failed" });
    const after = await connection.db
      .select({ event: schema.webhookDeliveries.event })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.orgId, orgId));
    expect(after).toHaveLength(3);
    expect(failed.id).not.toBe(unknown.id);
  });
});
