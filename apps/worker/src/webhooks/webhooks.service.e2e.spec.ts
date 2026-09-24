import { randomUUID } from "node:crypto";
import { createDb, runMigrations, schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { postWebhook } from "./webhook-http";

vi.mock("./webhook-http", () => ({ postWebhook: vi.fn() }));

const url = process.env.TEST_DATABASE_URL;
const mockPost = vi.mocked(postWebhook);

describe.skipIf(!url)("webhook delivery state", () => {
  let direct: ReturnType<typeof createDb>;
  let workerPool: ReturnType<typeof createDb>["pool"];
  let service: InstanceType<typeof import("./webhooks.service").WebhooksService>;
  let orgId: string;
  let subscriptionId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.WEB_ORIGIN = "https://pubrick.example";
    await runMigrations(url as string);
    direct = createDb(url as string);
    workerPool = (await import("../db")).pool;
    const { WebhooksService } = await import("./webhooks.service");
    service = new WebhooksService();
    orgId = `wh-worker-${randomUUID()}`;
    await direct.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Webhooks", slug: orgId });
    const [subscription] = await direct.db
      .insert(schema.webhookSubscriptions)
      .values({
        orgId,
        name: "Test",
        endpointEncrypted: encryptJson(
          { url: "https://hooks.example.com/events" },
          process.env.APP_ENCRYPTION_KEY,
        ),
        secretEncrypted: encryptJson({ secret: "whsec_test" }, process.env.APP_ENCRYPTION_KEY),
      })
      .returning({ id: schema.webhookSubscriptions.id });
    if (!subscription) throw new Error("Subscription fixture missing");
    subscriptionId = subscription.id;
  });

  beforeEach(async () => {
    mockPost.mockReset();
    await direct.db
      .delete(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.orgId, orgId));
  });

  afterAll(async () => {
    if (direct) {
      await direct.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await direct.pool.end();
      await workerPool?.end();
    }
  });

  async function event() {
    const [publication] = await direct.db
      .insert(schema.publications)
      .values({ orgId, status: "failed" })
      .returning({ id: schema.publications.id });
    if (!publication) throw new Error("Publication fixture missing");
    const [delivery] = await direct.db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.publicationId, publication.id));
    if (!delivery) throw new Error("Trigger did not queue delivery");
    return delivery.id;
  }

  async function state(id: string) {
    const [row] = await direct.db
      .select({
        status: schema.webhookDeliveries.status,
        attempts: schema.webhookDeliveries.attempts,
        lastHttpStatus: schema.webhookDeliveries.lastHttpStatus,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, id));
    return row;
  }

  it("bounds retries on explicit 408, 429, and 5xx responses with one stable event ID", async () => {
    const id = await event();
    for (const [index, code] of [408, 429, 500, 503, 503].entries()) {
      mockPost.mockResolvedValueOnce(code);
      await service.scan(orgId);
      const row = await state(id);
      expect(row?.attempts).toBe(index + 1);
      expect(row?.lastHttpStatus).toBe(code);
      if (index < 4) {
        expect(row?.status).toBe("pending");
        await direct.db
          .update(schema.webhookDeliveries)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(schema.webhookDeliveries.id, id));
      } else {
        expect(row?.status).toBe("failed");
      }
    }
    await service.scan(orgId);
    expect(mockPost).toHaveBeenCalledTimes(5);
    expect(mockPost.mock.calls.every((call) => call[2].id === id)).toBe(true);
  });

  it("marks an ambiguous network failure unknown and never resends", async () => {
    const id = await event();
    mockPost.mockRejectedValueOnce(new Error("socket reset after POST"));
    await service.scan(orgId);
    await service.scan(orgId);
    expect(await state(id)).toMatchObject({ status: "unknown", attempts: 1, lastHttpStatus: null });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("sweeps a stale claimed request to unknown without making an HTTP request", async () => {
    const id = await event();
    await direct.db
      .update(schema.webhookDeliveries)
      .set({
        status: "attempting",
        attempts: 1,
        updatedAt: new Date(0),
      })
      .where(eq(schema.webhookDeliveries.id, id));
    await service.scan(orgId);
    expect(await state(id)).toMatchObject({ status: "unknown", attempts: 1 });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses to send after a subscription is revoked between claim and load", async () => {
    const id = await event();
    const pendingId = await event();
    const [delivery] = await direct.db
      .select({
        id: schema.webhookDeliveries.id,
        orgId: schema.webhookDeliveries.orgId,
        subscriptionId: schema.webhookDeliveries.subscriptionId,
        event: schema.webhookDeliveries.event,
        payload: schema.webhookDeliveries.payload,
        createdAt: schema.webhookDeliveries.createdAt,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, id));
    if (!delivery) throw new Error("Delivery fixture missing");
    await direct.db
      .update(schema.webhookDeliveries)
      .set({ status: "attempting", attempts: 1 })
      .where(eq(schema.webhookDeliveries.id, id));
    await direct.db
      .update(schema.webhookSubscriptions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.webhookSubscriptions.orgId, orgId),
          eq(schema.webhookSubscriptions.id, subscriptionId),
        ),
      );
    await (
      service as unknown as {
        deliver: (event: typeof delivery & { attempts: number }) => Promise<void>;
      }
    ).deliver({ ...delivery, attempts: 1 });
    expect(mockPost).not.toHaveBeenCalled();
    expect((await state(id))?.status).toBe("failed");
    await service.scan(orgId);
    expect((await state(pendingId))?.status).toBe("failed");
    expect(mockPost).not.toHaveBeenCalled();
  });
});
